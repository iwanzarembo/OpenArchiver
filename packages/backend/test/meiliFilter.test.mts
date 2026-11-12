/**
 * Unit tests for the Meilisearch filter builder.
 *
 * Runs against the compiled backend (`pnpm --filter @open-archiver/backend build` first):
 *
 *   pnpm --filter @open-archiver/backend test:unit
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmailSearchFilter } from '../dist/helpers/meiliFilter.js';

describe('buildEmailSearchFilter — mailboxPaths', () => {
	test('filters one folder with =', () => {
		assert.equal(
			buildEmailSearchFilter({ mailboxPaths: ['Templates'] }),
			'mailboxPath = "Templates"'
		);
	});

	test('OR-combines several folders with IN', () => {
		assert.equal(
			buildEmailSearchFilter({ mailboxPaths: ['INBOX', 'Templates'] }),
			'mailboxPath IN ["INBOX", "Templates"]'
		);
	});

	test('escapes quotes and backslashes', () => {
		assert.equal(
			buildEmailSearchFilter({ mailboxPaths: ['A "B"', 'C\\D'] }),
			'mailboxPath IN ["A \\"B\\"", "C\\\\D"]'
		);
	});

	test('keeps the provider delimiter untouched', () => {
		assert.equal(
			buildEmailSearchFilter({ mailboxPaths: ['0 Haus.Rechnungen'] }),
			'mailboxPath = "0 Haus.Rechnungen"'
		);
	});

	test('AND-combines the folder with the other filters', () => {
		assert.equal(
			buildEmailSearchFilter({
				mailboxPaths: ['Templates'],
				sources: ['11111111-1111-1111-1111-111111111111'],
				hasAttachments: true,
			}),
			'ingestionSourceId = "11111111-1111-1111-1111-111111111111" AND mailboxPath = "Templates" AND hasAttachments = true'
		);
	});

	test('emits no clause without mailboxPaths', () => {
		assert.equal(buildEmailSearchFilter({}), undefined);
	});
});
