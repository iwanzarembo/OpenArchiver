import { randomUUID } from 'node:crypto';
import { and, inArray } from 'drizzle-orm';
import type { User } from '@open-archiver/types';
import { db } from '../database';
import { archivedEmails } from '../database/schema';
import { FilterBuilder } from './FilterBuilder';
import { ArchivedEmailService } from './ArchivedEmailService';
import { logger } from '../config/logger';

export interface BulkDeleteJob {
	id: string;
	userId: string;
	/** Number of rows the job resolved for the requested folder paths. */
	total: number;
	done: number;
	deleted: number;
	/** Blocked by a legal hold or retention policy. */
	blocked: number;
	failed: number;
	/** Capped list of per-id failures; counts stay exact. */
	errors: { id: string; message: string }[];
	status: 'running' | 'completed';
	createdAt: string;
	finishedAt?: string;
}

/** Keeps the process from growing without bound when an admin runs several jobs. */
const MAX_JOBS = 20;

const jobs = new Map<string, BulkDeleteJob>();

/**
 * Deletes every archived email in a set of folder paths, one after another.
 *
 * The request only resolves the rows and starts the loop; deletion itself runs in the backend
 * process so the browser does not have to issue thousands of DELETE requests (and does not hit
 * the API rate limit). Each email goes through `ArchivedEmailService.deleteArchivedEmail`, which
 * keeps storage, Meilisearch and the audit log consistent and honours legal holds.
 *
 * The job lives in memory: a restart loses the progress, but every email that was already deleted
 * stays deleted, and re-running the job continues with what is left. This is deliberate — a
 * durable job table would need migrations and a cleanup policy for a rarely used admin action.
 */
export class BulkDeleteService {
	public static async start(
		userId: string,
		actor: User,
		actorIp: string,
		mailboxPaths: string[]
	): Promise<BulkDeleteJob> {
		const { drizzleFilter } = await FilterBuilder.create(userId, 'archive', 'delete');
		const pathFilter = inArray(archivedEmails.path, mailboxPaths);
		const rows = await db
			.select({ id: archivedEmails.id })
			.from(archivedEmails)
			.where(drizzleFilter ? and(pathFilter, drizzleFilter) : pathFilter);

		const job: BulkDeleteJob = {
			id: randomUUID(),
			userId,
			total: rows.length,
			done: 0,
			deleted: 0,
			blocked: 0,
			failed: 0,
			errors: [],
			status: rows.length === 0 ? 'completed' : 'running',
			createdAt: new Date().toISOString(),
			...(rows.length === 0 ? { finishedAt: new Date().toISOString() } : {}),
		};

		jobs.set(job.id, job);
		BulkDeleteService.prune();

		if (rows.length > 0) {
			logger.info(
				{ jobId: job.id, userId, folders: mailboxPaths, total: rows.length },
				'Bulk folder deletion started'
			);
			void BulkDeleteService.run(
				job,
				rows.map((row) => row.id),
				actor,
				actorIp
			);
		}

		return job;
	}

	public static get(jobId: string, userId: string): BulkDeleteJob | undefined {
		const job = jobs.get(jobId);
		// A job id is guessable enough to matter: never show another admin's progress.
		return job && job.userId === userId ? job : undefined;
	}

	private static async run(
		job: BulkDeleteJob,
		ids: string[],
		actor: User,
		actorIp: string
	): Promise<void> {
		for (const id of ids) {
			try {
				await ArchivedEmailService.deleteArchivedEmail(id, actor, actorIp);
				job.deleted++;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.startsWith('Deletion blocked by retention policy')) {
					job.blocked++;
				} else {
					job.failed++;
					if (job.errors.length < 100) {
						job.errors.push({ id, message });
					}
				}
			} finally {
				job.done++;
			}
		}

		job.status = 'completed';
		job.finishedAt = new Date().toISOString();
		logger.info(
			{
				jobId: job.id,
				total: job.total,
				deleted: job.deleted,
				blocked: job.blocked,
				failed: job.failed,
			},
			'Bulk folder deletion finished'
		);
	}

	private static prune(): void {
		if (jobs.size <= MAX_JOBS) return;
		const oldest = [...jobs.values()]
			.filter((job) => job.status === 'completed')
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
			.slice(0, jobs.size - MAX_JOBS);
		for (const job of oldest) {
			jobs.delete(job.id);
		}
	}
}
