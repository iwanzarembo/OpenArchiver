import type { FolderFilter } from '@open-archiver/types';

/**
 * What the historic mailbox selection (before per-source folder filters existed) does
 * with one mailbox. Kept as its own function so the filter code cannot drift from the
 * behaviour it has to preserve when no filter is configured.
 */
export interface FolderFilterOptions {
	/** The mailbox is the account's Drafts folder. */
	isDrafts: boolean;
	/** The mailbox is a Junk or Trash folder. */
	isJunkOrTrash: boolean;
	/** `ARCHIVE_DRAFTS` — archive unsent drafts. */
	archiveDrafts: boolean;
	/** `ALL_INCLUSIVE_ARCHIVE` — archive Junk and Trash as well. */
	allInclusive: boolean;
}

/** The selection used when a source has no filter: all folders, minus Drafts/Junk/Trash. */
function legacySelection(opts: FolderFilterOptions): boolean {
	if (!opts.archiveDrafts && opts.isDrafts) {
		return false;
	}
	if (!opts.allInclusive && opts.isJunkOrTrash) {
		return false;
	}
	return true;
}

/**
 * Compiles one folder pattern into an anchored RegExp.
 *
 * Only `*` (any run of characters, including the hierarchy delimiter) and `?` (one
 * character) are special. Folder names legitimately contain `.`, `+`, `(`, `[`, `\` and
 * other regex metacharacters — because `.` is the delimiter on the servers this exists
 * for — so every other character has to be escaped rather than passed through.
 */
function compilePattern(pattern: string, caseSensitive: boolean): RegExp {
	let source = '^';
	for (const character of pattern) {
		if (character === '*') {
			source += '.*';
		} else if (character === '?') {
			source += '.';
		} else {
			source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		}
	}
	source += '$';
	return new RegExp(source, caseSensitive ? '' : 'i');
}

/**
 * Decides whether one mailbox path is archived.
 *
 * Order matters, and each branch is deliberate:
 *
 * 1. No filter → the historic behaviour, byte for byte.
 * 2. `include` → archive only what matches. Drafts, Junk and Trash are not special here:
 *    naming one of them is the explicit request to archive it. A missing or empty list
 *    matches nothing, so a half-configured source archives nothing instead of everything.
 * 3. `exclude` → the historic behaviour, then remove what matches. An explicit exclusion
 *    wins over `allInclusive`; that is the point of configuring it.
 */
export function matchesFolderFilter(
	path: string,
	filter: FolderFilter | null | undefined,
	opts: FolderFilterOptions
): boolean {
	if (!filter) {
		return legacySelection(opts);
	}

	const rawPatterns: unknown = filter.folders;
	const patterns = Array.isArray(rawPatterns)
		? rawPatterns.filter((pattern): pattern is string => typeof pattern === 'string')
		: [];
	const caseSensitive = filter.caseSensitive === true;
	const matches = patterns.some((pattern) => compilePattern(pattern, caseSensitive).test(path));

	if (filter.mode === 'include') {
		return patterns.length > 0 && matches;
	}

	// `exclude` (and any value that is not a known mode, treated as the default so a
	// malformed row cannot silently start archiving everything).
	return legacySelection(opts) && !matches;
}
