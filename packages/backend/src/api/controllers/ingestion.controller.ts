import { Request, Response } from 'express';
import { IngestionService } from '../../services/IngestionService';
import { ArchiveMaintenanceService } from '../../services/ArchiveMaintenanceService';
import {
	CreateIngestionSourceDto,
	UpdateIngestionSourceDto,
	IngestionSource,
	SafeIngestionSource,
	GenericImapCredentials,
	OAuthMailboxCredentials,
} from '@open-archiver/types';
import { logger } from '../../config/logger';
import { UserService } from '../../services/UserService';
import { AuditService } from '../../services/AuditService';
import { checkDeletionEnabled } from '../../helpers/deletionGuard';
import { mergeProviderCredentials } from '../../services/credentialMerge';
import {
	FolderListError,
	FolderListService,
	ImapFolderListConnection,
} from '../../services/FolderListService';
import {
	OAuthReauthorizationRequiredError,
	OAuthTokenService,
} from '../../services/oauth/OAuthTokenService';
import type { ReindexMode } from '@open-archiver/types';

/** A request-level problem with a translated body, raised before any IMAP connection. */
class FolderListRequestError extends Error {
	constructor(
		public readonly translationKey: string,
		public readonly httpStatus = 400
	) {
		super(translationKey);
		this.name = 'FolderListRequestError';
	}
}

export class IngestionController {
	/**
	 * Whether the duplicate-email endpoints answer at all.
	 *
	 * Off while the feature is held back from release. The routes stay registered and the service,
	 * job and sweep below are untouched, so re-enabling is this one flag — and a withheld endpoint
	 * answers with a reason rather than a 404, which would suggest the caller had the URL wrong.
	 *
	 * Typed `boolean` rather than left to infer `false`, so the code guarded by it is not narrowed
	 * to unreachable.
	 */
	private static readonly DUPLICATE_CLEANUP_ENABLED: boolean = false;

	private userService = new UserService();
	private auditService = new AuditService();
	/**
	 * Converts an IngestionSource object to a safe version for client-side consumption
	 * by removing the credentials.
	 * @param source The full IngestionSource object.
	 * @returns An object conforming to the SafeIngestionSource type.
	 */
	private toSafeIngestionSource(source: IngestionSource): SafeIngestionSource {
		const { credentials, ...safeSource } = source;
		return safeSource;
	}

	public create = async (req: Request, res: Response): Promise<Response> => {
		try {
			const dto: CreateIngestionSourceDto = req.body;
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const newSource = await IngestionService.create(
				dto,
				userId,
				actor,
				req.ip || 'unknown'
			);
			const safeSource = this.toSafeIngestionSource(newSource);
			return res.status(201).json(safeSource);
		} catch (error: any) {
			logger.error({ err: error }, 'Create ingestion source error');
			// Return a 400 Bad Request for connection errors
			return res.status(400).json({
				message: error.message || req.t('ingestion.failedToCreate'),
			});
		}
	};

	/**
	 * Lists the folders of a mailbox for the folder picker.
	 *
	 * Two modes:
	 * - `sourceId` (edit dialog): stored credentials are used, so the admin does not have to
	 *   retype a password the UI cannot show. A `providerConfig` from the form is merged on top
	 *   so a connection field that was changed but not yet saved is honoured.
	 * - `providerConfig` alone (create dialog): the credentials from the form are used.
	 *
	 * Only IMAP transports have folders to choose from. The Graph transport of an OAuth mailbox
	 * is deliberately refused instead of returning a list that the sync would ignore.
	 */
	public listFolders = async (req: Request, res: Response): Promise<Response> => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const sourceId =
			typeof body.sourceId === 'string' && body.sourceId !== '' ? body.sourceId : undefined;
		const providerConfig =
			body.providerConfig &&
			typeof body.providerConfig === 'object' &&
			!Array.isArray(body.providerConfig)
				? (body.providerConfig as Record<string, any>)
				: undefined;

		if (!sourceId && !providerConfig) {
			return res.status(400).json({ message: req.t('ingestion.foldersMissingConfig') });
		}

		try {
			const connection = sourceId
				? await this.folderConnectionForSource(sourceId, providerConfig)
				: this.folderConnectionForForm(providerConfig!, body.provider);

			if (!connection) {
				return res.status(400).json({ message: req.t('ingestion.foldersNotSupported') });
			}

			const folders = await FolderListService.listFolders(connection);
			return res.status(200).json({ folders });
		} catch (error) {
			if (error instanceof FolderListRequestError) {
				return res.status(error.httpStatus).json({ message: req.t(error.translationKey) });
			}
			if (error instanceof OAuthReauthorizationRequiredError) {
				return res.status(401).json({ message: error.message });
			}
			if (error instanceof FolderListError) {
				const key =
					error.code === 'imap_auth_failed'
						? 'ingestion.foldersAuthFailed'
						: error.code === 'imap_timeout'
							? 'ingestion.foldersTimeout'
							: 'ingestion.foldersConnectionFailed';
				logger.warn(
					{ sourceId, code: error.code, message: error.message },
					'Folder listing failed'
				);
				return res.status(error.httpStatus).json({ message: req.t(key) });
			}
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			if (error instanceof Error && error.message.startsWith('Missing required')) {
				return res.status(400).json({ message: error.message });
			}
			if (error instanceof Error && error.message.startsWith('Changing the provider')) {
				return res.status(400).json({ message: error.message });
			}
			logger.warn(
				{ sourceId, message: error instanceof Error ? error.message : String(error) },
				'Folder listing error'
			);
			return res.status(400).json({ message: req.t('ingestion.foldersConnectionFailed') });
		}
	};

	/** Builds the IMAP connection for an existing source, merging unsaved form values. */
	private async folderConnectionForSource(
		sourceId: string,
		providerConfig?: Record<string, any>
	): Promise<ImapFolderListConnection | null> {
		const source = await IngestionService.findById(sourceId);

		if (source.provider === 'oauth_mailbox') {
			const oauth = source.credentials as OAuthMailboxCredentials;
			// Graph folders are an id space of their own; pretending IMAP names apply would
			// create a filter the sync never evaluates.
			if ((oauth.transport ?? 'imap') === 'graph') {
				return null;
			}
			// Unsaved form edits are ignored here: changing an OAuth mailbox's connection
			// invalidates its token, so the source has to be saved and re-authorized first.
			return {
				host: oauth.imapHost,
				port: oauth.imapPort ?? 993,
				secure: true,
				username: oauth.authorizedEmail || oauth.email,
				accessTokenSupplier: () => OAuthTokenService.getValidAccessToken(source.id),
			};
		}

		if (source.provider !== 'generic_imap') {
			return null;
		}

		let credentials = source.credentials as GenericImapCredentials;
		if (providerConfig) {
			const merged = mergeProviderCredentials(credentials, providerConfig);
			if (!merged.ok) {
				throw new Error(merged.message);
			}
			credentials = merged.merged as GenericImapCredentials;
		}

		return this.folderConnectionFromCredentials(credentials);
	}

	private folderConnectionFromCredentials(
		credentials: GenericImapCredentials
	): ImapFolderListConnection {
		if (!credentials.host || !credentials.username || !credentials.password) {
			throw new FolderListRequestError('ingestion.foldersMissingConfig');
		}
		return {
			host: credentials.host,
			port: Number(credentials.port) || 993,
			secure: credentials.secure !== false,
			allowInsecureCert: credentials.allowInsecureCert === true,
			username: credentials.username,
			password: credentials.password,
		};
	}

	/** Builds the IMAP connection for a not-yet-saved form. */
	private folderConnectionForForm(
		providerConfig: Record<string, any>,
		provider?: unknown
	): ImapFolderListConnection {
		const type = providerConfig.type ?? provider;

		if (type === 'oauth_mailbox') {
			// The edit dialog after saving uses sourceId; a fresh OAuth form has no token yet.
			throw new FolderListRequestError('ingestion.foldersNeedAuthorization');
		}
		if (type !== 'generic_imap') {
			throw new FolderListRequestError('ingestion.foldersNotSupported');
		}

		const host = providerConfig.host;
		const username = providerConfig.username;
		const password = providerConfig.password;
		if (
			typeof host !== 'string' ||
			!host ||
			typeof username !== 'string' ||
			!username ||
			!password
		) {
			throw new FolderListRequestError('ingestion.foldersMissingConfig');
		}

		return {
			host,
			port: Number(providerConfig.port) || 993,
			secure: providerConfig.secure !== false,
			allowInsecureCert: providerConfig.allowInsecureCert === true,
			username,
			password,
		};
	}

	public findAll = async (req: Request, res: Response): Promise<Response> => {
		try {
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const sources = await IngestionService.findAll(userId);
			const safeSources = sources.map(this.toSafeIngestionSource);
			return res.status(200).json(safeSources);
		} catch (error) {
			console.error('Find all ingestion sources error:', error);
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public findById = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const source = await IngestionService.findById(id);
			const safeSource = this.toSafeIngestionSource(source);
			return res.status(200).json(safeSource);
		} catch (error) {
			console.error(`Find ingestion source by id ${req.params.id} error:`, error);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public update = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const dto: UpdateIngestionSourceDto = req.body;
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const sourceToCheck = await IngestionService.findById(id);
			if (sourceToCheck.provider === 'smtp_journaling') {
				return res
					.status(400)
					.json({ message: req.t('ingestion.journalingSourceManagedByJournaling') });
			}
			// The auth_success transition triggers the initial import, and for an OAuth
			// mailbox it is the OAuth service's to make — a client setting it directly
			// would start an import on a source that holds no tokens.
			if (sourceToCheck.provider === 'oauth_mailbox' && dto.status === 'auth_success') {
				delete dto.status;
			}
			const updatedSource = await IngestionService.update(
				id,
				dto,
				actor,
				req.ip || 'unknown'
			);
			const safeSource = this.toSafeIngestionSource(updatedSource);
			return res.status(200).json(safeSource);
		} catch (error) {
			console.error(`Update ingestion source ${req.params.id} error:`, error);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public delete = async (req: Request, res: Response): Promise<Response> => {
		try {
			checkDeletionEnabled();
			const { id } = req.params;
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const sourceToCheck = await IngestionService.findById(id);
			if (sourceToCheck.provider === 'smtp_journaling') {
				return res
					.status(400)
					.json({ message: req.t('ingestion.journalingSourceManagedByJournaling') });
			}
			await IngestionService.delete(id, actor, req.ip || 'unknown');
			return res.status(204).send();
		} catch (error) {
			console.error(`Delete ingestion source ${req.params.id} error:`, error);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			} else if (error instanceof Error) {
				return res.status(400).json({ message: error.message });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public triggerInitialImport = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			await IngestionService.triggerInitialImport(id);
			return res.status(202).json({ message: req.t('ingestion.initialImportTriggered') });
		} catch (error) {
			console.error(`Trigger initial import for ${req.params.id} error:`, error);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public pause = async (req: Request, res: Response): Promise<Response> => {
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
			const sourceToCheck = await IngestionService.findById(id);
			if (sourceToCheck.provider === 'smtp_journaling') {
				return res
					.status(400)
					.json({ message: req.t('ingestion.journalingSourceManagedByJournaling') });
			}
			const updatedSource = await IngestionService.update(
				id,
				{ status: 'paused' },
				actor,
				req.ip || 'unknown'
			);
			const safeSource = this.toSafeIngestionSource(updatedSource);
			return res.status(200).json(safeSource);
		} catch (error) {
			console.error(`Pause ingestion source ${req.params.id} error:`, error);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public unmerge = async (req: Request, res: Response): Promise<Response> => {
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
			const sourceToCheck = await IngestionService.findById(id);
			if (sourceToCheck.provider === 'smtp_journaling') {
				return res
					.status(400)
					.json({ message: req.t('ingestion.journalingSourceManagedByJournaling') });
			}
			const updatedSource = await IngestionService.unmerge(id, actor, req.ip || 'unknown');
			const safeSource = this.toSafeIngestionSource(updatedSource);
			return res.status(200).json(safeSource);
		} catch (error) {
			logger.error({ err: error }, `Unmerge ingestion source ${req.params.id} error`);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			} else if (error instanceof Error) {
				return res.status(400).json({ message: error.message });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public triggerForceSync = async (req: Request, res: Response): Promise<Response> => {
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
			const sourceToCheck = await IngestionService.findById(id);
			if (sourceToCheck.provider === 'smtp_journaling') {
				return res
					.status(400)
					.json({ message: req.t('ingestion.journalingSourceManagedByJournaling') });
			}
			await IngestionService.triggerForceSync(id, actor, req.ip || 'unknown');
			return res.status(202).json({ message: req.t('ingestion.forceSyncTriggered') });
		} catch (error) {
			console.error(`Trigger force sync for ${req.params.id} error:`, error);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public reindex = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			// Default to 'missing' (cheap self-heal); allow explicit 'full' rebuild.
			const mode: ReindexMode = req.body?.mode === 'full' ? 'full' : 'missing';
			const dispatch = await IngestionService.triggerReindex(id, mode);

			await this.auditService.createAuditLog({
				actorIdentifier: userId,
				actionType: 'REINDEX',
				targetType: 'IngestionSource',
				targetId: id,
				actorIp: req.ip || 'unknown',
				details: { scope: 'source', mode, pending: dispatch.pending },
			});

			// 202 still: the work is asynchronous. The body is what stops "accepted" being read as
			// "done" — it says how much was queued and whether anything is there to run it.
			return res.status(202).json({
				message: req.t('ingestion.reindexTriggered'),
				...dispatch,
			});
		} catch (error) {
			logger.error({ err: error }, `Trigger reindex for ${req.params.id} error`);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public reindexAll = async (req: Request, res: Response): Promise<Response> => {
		try {
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const mode: ReindexMode = req.body?.mode === 'full' ? 'full' : 'missing';
			const dispatch = await IngestionService.triggerReindexAll(mode);

			await this.auditService.createAuditLog({
				actorIdentifier: userId,
				actionType: 'REINDEX',
				targetType: 'IngestionSource',
				targetId: null,
				actorIp: req.ip || 'unknown',
				details: { scope: 'all', mode, pending: dispatch.pending },
			});

			return res.status(202).json({
				message: req.t('ingestion.reindexTriggered'),
				...dispatch,
			});
		} catch (error) {
			logger.error({ err: error }, 'Trigger reindex-all error');
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public getDuplicateCount = async (req: Request, res: Response): Promise<Response> => {
		if (!IngestionController.DUPLICATE_CLEANUP_ENABLED) {
			return res
				.status(503)
				.json({ message: req.t('ingestion.duplicateCleanupUnavailable') });
		}
		try {
			const counts = await ArchiveMaintenanceService.countDuplicates(req.params.id);
			return res.status(200).json(counts);
		} catch (error) {
			logger.error({ err: error, id: req.params.id }, 'Get duplicate count error');
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	/**
	 * Queues a sweep that removes surplus copies of the same message.
	 *
	 * `req.params.id` is absent on the global route, and that is what selects the scope — undefined
	 * means every source.
	 */
	public cleanupDuplicates = async (req: Request, res: Response): Promise<Response> => {
		if (!IngestionController.DUPLICATE_CLEANUP_ENABLED) {
			return res
				.status(503)
				.json({ message: req.t('ingestion.duplicateCleanupUnavailable') });
		}
		try {
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			// Checked here rather than left to the worker, and through the same helper every other
			// deletion uses. The sweep deletes via the shared deletion path, which refuses outright
			// when ENABLE_DELETION is off — and it is off by default. Left to the job, the operator
			// would be told the cleanup had started and would then watch nothing happen, with the
			// reason buried in a worker log.
			try {
				checkDeletionEnabled();
			} catch {
				// The guard's own message is an i18next lookup keyed on an English sentence, which
				// resolves to an empty string when that sentence is not in the catalogue. The text
				// here is a real key, and it names the setting to change.
				return res.status(403).json({ message: req.t('ingestion.deletionDisabled') });
			}

			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const ingestionSourceId = req.params.id;
			const dispatch = await ArchiveMaintenanceService.triggerCleanupDuplicates(
				actor,
				req.ip || 'unknown',
				ingestionSourceId
			);

			// The sweep's own removals are audited one by one by deleteArchivedEmail. This records
			// the decision to run it, which is the part no per-email entry can show.
			await this.auditService.createAuditLog({
				actorIdentifier: userId,
				actionType: 'DELETE',
				targetType: 'IngestionSource',
				targetId: ingestionSourceId ?? null,
				actorIp: req.ip || 'unknown',
				details: {
					reason: 'DuplicateCleanup',
					scope: ingestionSourceId ? 'source' : 'all',
					duplicatesFound: dispatch.duplicatesFound,
					alreadyRunning: dispatch.alreadyRunning,
				},
			});

			return res.status(202).json({
				message: req.t('ingestion.duplicateCleanupTriggered'),
				...dispatch,
			});
		} catch (error) {
			logger.error({ err: error, id: req.params.id }, 'Trigger duplicate cleanup error');
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public getIndexHealth = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const health = await IngestionService.getIndexHealth(id);
			return res.status(200).json(health);
		} catch (error) {
			logger.error({ err: error }, `Get index health for ${req.params.id} error`);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public getStats = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const stats = await IngestionService.getIngestionStats(id);
			return res.status(200).json(stats);
		} catch (error) {
			logger.error({ err: error }, `Get stats for ${req.params.id} error`);
			if (error instanceof Error && error.message === 'Ingestion source not found') {
				return res.status(404).json({ message: req.t('ingestion.notFound') });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};
}
