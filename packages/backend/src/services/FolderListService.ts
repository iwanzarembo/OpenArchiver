import { ImapFlow } from 'imapflow';
import { OAuthReauthorizationRequiredError } from './oauth/OAuthTokenService';

/** Hard limit for the whole folder listing, including connect and logout. */
const LIST_TIMEOUT_MS = 15_000;

export type FolderListErrorCode = 'imap_auth_failed' | 'imap_timeout' | 'imap_connection_failed';

/** A failure the controller can turn into a status code and a translated message. */
export class FolderListError extends Error {
	constructor(
		public readonly code: FolderListErrorCode,
		message: string,
		public readonly httpStatus: number
	) {
		super(message);
		this.name = 'FolderListError';
	}
}

/** The subset of IMAP settings needed to list folders, with either password or token auth. */
export interface ImapFolderListConnection {
	host: string;
	port: number;
	secure: boolean;
	allowInsecureCert?: boolean;
	username: string;
	/** Password auth (generic_imap). */
	password?: string;
	/** XOAUTH2 auth (oauth_mailbox); asked for fresh on every connection. */
	accessTokenSupplier?: () => Promise<string>;
}

export interface ListedFolder {
	path: string;
	delimiter: string;
	specialUse: string | null;
	flags: string[];
	exists: number;
}

/**
 * Lists the mailboxes of one IMAP account for the folder picker.
 *
 * Deliberately separate from `ImapConnector`: the connector is built around a long-running sync
 * lifecycle (retries, UID state, mailbox locks), while this is one short request. Sharing it would
 * mean either exposing half its state or retrying a request an admin is waiting on.
 *
 * Credentials are never logged; the ImapFlow logger is disabled for the same reason.
 */
export class FolderListService {
	public static async listFolders(connection: ImapFolderListConnection): Promise<ListedFolder[]> {
		const auth = connection.accessTokenSupplier
			? { user: connection.username, accessToken: await connection.accessTokenSupplier() }
			: { user: connection.username, pass: connection.password };

		const client = new ImapFlow({
			host: connection.host,
			port: connection.port,
			secure: connection.secure,
			tls: {
				rejectUnauthorized: !connection.allowInsecureCert,
				requestCert: true,
			},
			auth,
			// The default logger logs the username on every handshake.
			logger: false,
			connectionTimeout: LIST_TIMEOUT_MS,
			greetingTimeout: LIST_TIMEOUT_MS,
			socketTimeout: LIST_TIMEOUT_MS,
		});

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(
					new FolderListError(
						'imap_timeout',
						`The IMAP server did not answer within ${LIST_TIMEOUT_MS / 1000} seconds.`,
						400
					)
				);
			}, LIST_TIMEOUT_MS);
		});
		const withinTimeout = <T>(operation: Promise<T>): Promise<T> =>
			Promise.race([operation, timeout]);

		try {
			await withinTimeout(client.connect());
			// `statusQuery` turns the LIST response into one that also carries the message
			// count, so the picker can show which folders are empty without one STATUS
			// round-trip per folder.
			const mailboxes = await withinTimeout(client.list({ statusQuery: { messages: true } }));

			return mailboxes
				.map((mailbox) => ({
					path: mailbox.path,
					delimiter: mailbox.delimiter,
					specialUse: mailbox.specialUse ?? null,
					flags: Array.from(mailbox.flags ?? []),
					exists: mailbox.status?.messages ?? 0,
				}))
				.sort((a, b) => a.path.localeCompare(b.path));
		} catch (error) {
			if (error instanceof FolderListError) {
				throw error;
			}
			// The OAuth service's own error already names the address and the fix.
			if (error instanceof OAuthReauthorizationRequiredError) {
				throw error;
			}

			const authFailed = (error as { authenticationFailed?: boolean })?.authenticationFailed;
			const responseText = (error as { responseText?: string })?.responseText;
			if (authFailed) {
				throw new FolderListError(
					'imap_auth_failed',
					'IMAP login failed. Check the username and password.',
					401
				);
			}
			throw new FolderListError(
				'imap_connection_failed',
				responseText
					? `IMAP connection failed: ${responseText}`
					: `IMAP connection failed: ${(error as Error)?.message ?? 'unknown error'}`,
				400
			);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			// Best effort: a server that never completed LOGIN has nothing to log out of,
			// and a hanging logout must not replace the error the caller needs to see.
			try {
				await Promise.race([
					client.logout(),
					new Promise((resolve) => setTimeout(resolve, 2_000)),
				]);
			} catch {
				try {
					client.close();
				} catch {
					// already gone
				}
			}
		}
	}
}
