/**
 * Unit tests for the mailbox folder filter.
 *
 * Runs against the compiled backend (`pnpm --filter @open-archiver/backend build` first):
 *
 *   pnpm --filter @open-archiver/backend test:unit
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchesFolderFilter } from '../dist/helpers/folderFilter.js';
import type { FolderFilter } from '@open-archiver/types';

const baseOptions = {
	isDrafts: false,
	isJunkOrTrash: false,
	archiveDrafts: false,
	allInclusive: false,
};

const filter = (
	mode: FolderFilter['mode'],
	folders: string[],
	caseSensitive = false
): FolderFilter => ({
	mode,
	folders,
	caseSensitive,
});

describe('matchesFolderFilter', () => {
	describe('without a filter (legacy behaviour)', () => {
		test('archives an ordinary folder', () => {
			assert.equal(matchesFolderFilter('INBOX', null, baseOptions), true);
			assert.equal(matchesFolderFilter('INBOX', undefined, baseOptions), true);
		});

		test('skips Drafts unless ARCHIVE_DRAFTS is set', () => {
			assert.equal(
				matchesFolderFilter('Drafts', null, { ...baseOptions, isDrafts: true }),
				false
			);
			assert.equal(
				matchesFolderFilter('Drafts', null, {
					...baseOptions,
					isDrafts: true,
					archiveDrafts: true,
				}),
				true
			);
		});

		test('skips Junk and Trash unless ALL_INCLUSIVE_ARCHIVE is set', () => {
			assert.equal(
				matchesFolderFilter('Spam', null, { ...baseOptions, isJunkOrTrash: true }),
				false
			);
			assert.equal(
				matchesFolderFilter('Spam', null, {
					...baseOptions,
					isJunkOrTrash: true,
					allInclusive: true,
				}),
				true
			);
		});
	});

	describe('exclude mode', () => {
		test('keeps everything but the named folder', () => {
			const f = filter('exclude', ['Templates']);
			assert.equal(matchesFolderFilter('Templates', f, baseOptions), false);
			assert.equal(matchesFolderFilter('INBOX', f, baseOptions), true);
			assert.equal(matchesFolderFilter('Templates.Old', f, baseOptions), true);
		});

		test('matches folder paths that use the server delimiter', () => {
			const f = filter('exclude', ['0 Haus.Rechnungen']);
			assert.equal(matchesFolderFilter('0 Haus.Rechnungen', f, baseOptions), false);
			assert.equal(matchesFolderFilter('0 Haus.Versicherungen', f, baseOptions), true);
		});

		test('supports * and ? globs', () => {
			const f = filter('exclude', ['Archiv.*', 'Temp?']);
			assert.equal(matchesFolderFilter('Archiv.2025', f, baseOptions), false);
			assert.equal(matchesFolderFilter('Archiv.2025.Rechnungen', f, baseOptions), false);
			assert.equal(matchesFolderFilter('Temp1', f, baseOptions), false);
			assert.equal(matchesFolderFilter('Temp12', f, baseOptions), true);
			assert.equal(matchesFolderFilter('Archiv', f, baseOptions), true);
		});

		test('escapes regex metacharacters in folder names', () => {
			const f = filter('exclude', ['A+B (alt) [x]']);
			assert.equal(matchesFolderFilter('A+B (alt) [x]', f, baseOptions), false);
			// `.` would be a wildcard without escaping.
			assert.equal(matchesFolderFilter('A+B (alt) x', f, baseOptions), true);
		});

		test('is case-insensitive by default and case-sensitive on request', () => {
			assert.equal(
				matchesFolderFilter('templates', filter('exclude', ['Templates']), baseOptions),
				false
			);
			assert.equal(
				matchesFolderFilter(
					'templates',
					filter('exclude', ['Templates'], true),
					baseOptions
				),
				true
			);
		});

		test('an empty list behaves exactly like no filter', () => {
			const f = filter('exclude', []);
			assert.equal(matchesFolderFilter('INBOX', f, baseOptions), true);
			assert.equal(
				matchesFolderFilter('Drafts', f, { ...baseOptions, isDrafts: true }),
				false
			);
		});

		test('still skips Drafts/Junk/Trash that are not named', () => {
			const f = filter('exclude', ['Templates']);
			assert.equal(
				matchesFolderFilter('Drafts', f, { ...baseOptions, isDrafts: true }),
				false
			);
			assert.equal(
				matchesFolderFilter('Trash', f, { ...baseOptions, isJunkOrTrash: true }),
				false
			);
		});

		test('an explicit exclusion wins over ALL_INCLUSIVE_ARCHIVE', () => {
			const f = filter('exclude', ['Trash']);
			assert.equal(
				matchesFolderFilter('Trash', f, {
					...baseOptions,
					isJunkOrTrash: true,
					allInclusive: true,
				}),
				false
			);
		});

		test('can exclude a draft folder even with ARCHIVE_DRAFTS set', () => {
			const f = filter('exclude', ['Drafts']);
			assert.equal(
				matchesFolderFilter('Drafts', f, {
					...baseOptions,
					isDrafts: true,
					archiveDrafts: true,
				}),
				false
			);
		});
	});

	describe('include mode', () => {
		test('archives only the named folder', () => {
			const f = filter('include', ['INBOX', '0 Haus.Rechnungen']);
			assert.equal(matchesFolderFilter('INBOX', f, baseOptions), true);
			assert.equal(matchesFolderFilter('0 Haus.Rechnungen', f, baseOptions), true);
			assert.equal(matchesFolderFilter('0 Haus.Versicherungen', f, baseOptions), false);
		});

		test('supports globs', () => {
			const f = filter('include', ['0 Haus.*']);
			assert.equal(matchesFolderFilter('0 Haus.Rechnungen', f, baseOptions), true);
			assert.equal(matchesFolderFilter('INBOX', f, baseOptions), false);
		});

		test('is case-insensitive by default and case-sensitive on request', () => {
			assert.equal(
				matchesFolderFilter('inbox', filter('include', ['INBOX']), baseOptions),
				true
			);
			assert.equal(
				matchesFolderFilter('inbox', filter('include', ['INBOX'], true), baseOptions),
				false
			);
			assert.equal(
				matchesFolderFilter('Inbox', filter('include', ['INBOX'], true), baseOptions),
				false
			);
		});

		test('an empty list archives nothing (fail-closed)', () => {
			assert.equal(matchesFolderFilter('INBOX', filter('include', []), baseOptions), false);
		});

		test('archives Drafts/Junk/Trash only when explicitly named', () => {
			const withoutThem = filter('include', ['INBOX']);
			assert.equal(
				matchesFolderFilter('Drafts', withoutThem, { ...baseOptions, isDrafts: true }),
				false
			);
			assert.equal(
				matchesFolderFilter('Trash', withoutThem, {
					...baseOptions,
					isJunkOrTrash: true,
				}),
				false
			);

			const withThem = filter('include', ['INBOX', 'Drafts', 'Trash']);
			assert.equal(
				matchesFolderFilter('Drafts', withThem, { ...baseOptions, isDrafts: true }),
				true
			);
			assert.equal(
				matchesFolderFilter('Trash', withThem, {
					...baseOptions,
					isJunkOrTrash: true,
				}),
				true
			);
		});

		test('does not depend on ALL_INCLUSIVE_ARCHIVE', () => {
			const f = filter('include', ['INBOX']);
			assert.equal(
				matchesFolderFilter('INBOX', f, { ...baseOptions, allInclusive: true }),
				true
			);
		});
	});

	test('an unknown mode falls back to exclude semantics', () => {
		const f = { mode: 'nonsense', folders: ['Templates'] } as unknown as FolderFilter;
		assert.equal(matchesFolderFilter('Templates', f, baseOptions), false);
		assert.equal(matchesFolderFilter('INBOX', f, baseOptions), true);
	});

	test('a malformed folders value behaves like an empty list', () => {
		const broken = { mode: 'include', folders: 'Templates' } as unknown as FolderFilter;
		assert.equal(matchesFolderFilter('Templates', broken, baseOptions), false);

		const brokenExclude = { mode: 'exclude', folders: 42 } as unknown as FolderFilter;
		assert.equal(matchesFolderFilter('INBOX', brokenExclude, baseOptions), true);
	});
});
