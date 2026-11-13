import { Request, Response } from 'express';
import { ArchivedEmailService } from '../../services/ArchivedEmailService';
import { BulkDeleteService } from '../../services/BulkDeleteService';
import { UserService } from '../../services/UserService';
import { checkDeletionEnabled } from '../../helpers/deletionGuard';

export class ArchivedEmailController {
	private userService = new UserService();
	public getArchivedEmails = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { ingestionSourceId } = req.params;
			const page = parseInt(req.query.page as string, 10) || 1;
			const limit = parseInt(req.query.limit as string, 10) || 10;
			const userId = req.user?.sub;

			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const result = await ArchivedEmailService.getArchivedEmails(
				ingestionSourceId,
				page,
				limit,
				userId
			);
			return res.status(200).json(result);
		} catch (error) {
			console.error('Get archived emails error:', error);
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	/**
	 * Starts deleting every archived email in the given folder paths.
	 *
	 * The heavy work runs in the background; the caller polls the status endpoint. This is the
	 * difference between one request and thousands, which would run into the API rate limit and
	 * would stop as soon as the browser tab closes.
	 */
	public bulkDeleteByFolders = async (req: Request, res: Response): Promise<Response> => {
		try {
			checkDeletionEnabled();
		} catch (error) {
			return res.status(400).json({
				message: error instanceof Error ? error.message : req.t('errors.deletionDisabled'),
			});
		}

		const userId = req.user?.sub;
		if (!userId) {
			return res.status(401).json({ message: req.t('errors.unauthorized') });
		}

		const paths = (req.body as { mailboxPaths?: unknown })?.mailboxPaths;
		if (
			!Array.isArray(paths) ||
			paths.length === 0 ||
			paths.length > 500 ||
			paths.some((path) => typeof path !== 'string' || path.trim() === '')
		) {
			return res.status(400).json({
				message: req.t('archivedEmail.bulkDeletePathsRequired'),
			});
		}

		const actor = await this.userService.findById(userId);
		if (!actor) {
			return res.status(401).json({ message: req.t('errors.unauthorized') });
		}

		try {
			const job = await BulkDeleteService.start(userId, actor, req.ip || 'unknown', [
				...new Set(paths.map((path) => path.trim())),
			]);
			return res.status(202).json(job);
		} catch (error) {
			console.error('Bulk delete error:', error);
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public bulkDeleteStatus = async (req: Request, res: Response): Promise<Response> => {
		const userId = req.user?.sub;
		if (!userId) {
			return res.status(401).json({ message: req.t('errors.unauthorized') });
		}

		const job = BulkDeleteService.get(req.params.jobId, userId);
		if (!job) {
			return res.status(404).json({ message: req.t('errors.notFound') });
		}
		return res.status(200).json(job);
	};

	public getArchivedEmailById = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const userId = req.user?.sub;

			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const email = await ArchivedEmailService.getArchivedEmailById(
				id,
				userId,
				actor,
				req.ip || 'unknown'
			);
			if (!email) {
				return res.status(404).json({ message: req.t('archivedEmail.notFound') });
			}
			return res.status(200).json(email);
		} catch (error) {
			console.error(`Get archived email by id ${req.params.id} error:`, error);
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public deleteArchivedEmail = async (req: Request, res: Response): Promise<Response> => {
		// Guard: return 400 if deletion is disabled in system settings before touching anything else
		try {
			checkDeletionEnabled();
		} catch (error) {
			return res.status(400).json({
				message: error instanceof Error ? error.message : req.t('errors.deletionDisabled'),
			});
		}

		const { id } = req.params;
		const userId = req.user?.sub;
		if (!userId) {
			return res.status(401).json({ message: req.t('errors.unauthorized') });
		}
		const actor = await this.userService.findById(userId);
		if (!actor) {
			return res.status(401).json({ message: req.t('errors.unauthorized') });
		}

		try {
			await ArchivedEmailService.deleteArchivedEmail(id, actor, req.ip || 'unknown');
			return res.status(204).send();
		} catch (error) {
			console.error(`Delete archived email ${req.params.id} error:`, error);
			if (error instanceof Error) {
				if (error.message === 'Archived email not found') {
					return res.status(404).json({ message: req.t('archivedEmail.notFound') });
				}
				// Retention policy / legal hold blocks are user-facing 400 errors
				if (error.message.startsWith('Deletion blocked by retention policy')) {
					return res.status(400).json({ message: error.message });
				}
				return res.status(500).json({ message: error.message });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};
}
