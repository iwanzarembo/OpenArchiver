import type { PageServerLoad, RequestEvent } from './$types';
import { api } from '$lib/server/api';
import type { SearchResult, SafeIngestionSource } from '@open-archiver/types';

import type { MatchingStrategy } from '@open-archiver/types';

/** Query params that make up the advanced-search filter state, passed through verbatim. */
const FILTER_PARAMS = [
	'sources',
	'excludeSources',
	'from',
	'notFrom',
	'to',
	'notTo',
	'mailboxes',
	'mailboxPaths',
	'dateFrom',
	'dateTo',
	'searchIn',
	'hasAttachments',
	'sort',
] as const;

export type SearchFilterParams = Partial<Record<(typeof FILTER_PARAMS)[number], string>>;

async function performSearch(
	keywords: string,
	page: number,
	matchingStrategy: MatchingStrategy,
	filterParams: SearchFilterParams,
	event: RequestEvent
) {
	const hasFilters = Object.keys(filterParams).length > 0;
	const base = { keywords, page, matchingStrategy, filterParams };

	if (!keywords && !hasFilters) {
		return { searchResult: null, ...base, keywords: '', page: 1 };
	}

	try {
		const query = new URLSearchParams();
		if (keywords) query.set('keywords', keywords);
		query.set('page', String(page));
		query.set('limit', '10');
		query.set('matchingStrategy', matchingStrategy);
		for (const [key, value] of Object.entries(filterParams)) {
			if (value) query.set(key, value);
		}

		const response = await api(`/search?${query.toString()}`, event, { method: 'GET' });

		if (!response.ok) {
			const error = await response.json();
			return { searchResult: null, ...base, error: error.message };
		}

		const searchResult = (await response.json()) as SearchResult;
		return { searchResult, ...base };
	} catch (error) {
		return {
			searchResult: null,
			...base,
			error: error instanceof Error ? error.message : 'Unknown error',
		};
	}
}

/** Loads the ingestion sources for the filter dropdown; null when the user may not list them. */
async function loadIngestionSources(
	event: RequestEvent
): Promise<
	{ id: string; name: string; folderFilters: SafeIngestionSource['folderFilters'] }[] | null
> {
	try {
		const response = await api('/ingestion-sources', event, { method: 'GET' });
		if (!response.ok) return null;
		const sources = (await response.json()) as SafeIngestionSource[];
		return sources.map((s) => ({
			id: s.id,
			name: s.name,
			folderFilters: s.folderFilters ?? null,
		}));
	} catch {
		return null;
	}
}

/**
 * The folders that actually occur in the archive, taken from the index facet so the filter
 * only offers values that can produce results. 200 is above the folder counts this archive
 * has; the endpoint clamps it.
 */
async function loadFolderFacets(event: RequestEvent): Promise<string[]> {
	try {
		const response = await api('/search/facets?field=mailboxPaths&query=&limit=200', event, {
			method: 'GET',
		});
		if (!response.ok) return [];
		const data = (await response.json()) as { values?: string[] };
		return Array.isArray(data.values) ? data.values : [];
	} catch {
		return [];
	}
}

export const load: PageServerLoad = async (event) => {
	const keywords = event.url.searchParams.get('keywords') || '';
	const page = parseInt(event.url.searchParams.get('page') || '1');
	const matchingStrategy = (event.url.searchParams.get('matchingStrategy') ||
		'last') as MatchingStrategy;

	const filterParams: SearchFilterParams = {};
	for (const param of FILTER_PARAMS) {
		const value = event.url.searchParams.get(param);
		if (value) filterParams[param] = value;
	}

	const [result, ingestionSources, availableFolders] = await Promise.all([
		performSearch(keywords, page, matchingStrategy, filterParams, event),
		loadIngestionSources(event),
		loadFolderFacets(event),
	]);

	return { ...result, ingestionSources, availableFolders };
};
