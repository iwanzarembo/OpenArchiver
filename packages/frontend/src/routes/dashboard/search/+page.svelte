<script lang="ts">
	import type { PageData } from './$types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Select from '$lib/components/ui/select';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle,
		CardDescription,
	} from '$lib/components/ui/card';
	import { api } from '$lib/api.client';
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Progress } from '$lib/components/ui/progress';
	import type { MatchingStrategy } from '@open-archiver/types';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { t } from '$lib/translations';
	import * as Pagination from '$lib/components/ui/pagination/index.js';
	import ChevronLeft from 'lucide-svelte/icons/chevron-left';
	import ChevronRight from 'lucide-svelte/icons/chevron-right';
	import Paperclip from 'lucide-svelte/icons/paperclip';
	import SlidersHorizontal from 'lucide-svelte/icons/sliders-horizontal';
	import X from 'lucide-svelte/icons/x';
	import AdvancedSearchPanel from '$lib/components/search/AdvancedSearchPanel.svelte';
	import EmptyStateIcon from '$lib/components/custom/EmptyStateIcon.svelte';
	import Search from 'lucide-svelte/icons/search';
	import SearchX from 'lucide-svelte/icons/search-x';
	import { formatDateTimeStore } from '$lib/stores/dateFormat.store';

	let { data }: { data: PageData } = $props();
	let searchResult = $derived(data.searchResult);
	let keywords = $state(data.keywords || '');
	let page = $derived(data.page);
	let error = $derived(data.error);
	let matchingStrategy: MatchingStrategy = $state(
		(data.matchingStrategy as MatchingStrategy) || 'last'
	);

	// --- Advanced filter state, hydrated from the URL-derived load data ---
	const initial = data.filterParams ?? {};
	const csvToList = (value?: string) =>
		value
			? value
					.split(',')
					.map((v) => v.trim())
					.filter(Boolean)
			: [];
	let selectedSources = $state(csvToList(initial.sources));
	let excludedSources = $state(csvToList(initial.excludeSources));
	let fromAddresses = $state(csvToList(initial.from));
	let notFromAddresses = $state(csvToList(initial.notFrom));
	let toAddresses = $state(csvToList(initial.to));
	let notToAddresses = $state(csvToList(initial.notTo));
	let mailboxes = $state(csvToList(initial.mailboxes));
	let mailboxPaths = $state(csvToList(initial.mailboxPaths));
	let dateFrom = $state(initial.dateFrom ?? '');
	let dateTo = $state(initial.dateTo ?? '');
	let searchIn = $state(csvToList(initial.searchIn));
	let hasAttachments = $state(initial.hasAttachments ?? 'any');
	let sort = $state(initial.sort ?? 'date_desc');

	/** Serializes the full search state (keywords, options, filters) into URL params. */
	function buildSearchParams(pageNum: number): URLSearchParams {
		const params = new URLSearchParams();
		if (keywords) params.set('keywords', keywords);
		params.set('page', String(pageNum));
		params.set('matchingStrategy', matchingStrategy);
		const setCsv = (key: string, values: string[]) => {
			if (values.length > 0) params.set(key, values.join(','));
		};
		setCsv('sources', selectedSources);
		setCsv('excludeSources', excludedSources);
		setCsv('from', fromAddresses);
		setCsv('notFrom', notFromAddresses);
		setCsv('to', toAddresses);
		setCsv('notTo', notToAddresses);
		setCsv('mailboxes', mailboxes);
		setCsv('mailboxPaths', mailboxPaths);
		if (dateFrom) params.set('dateFrom', dateFrom);
		if (dateTo) params.set('dateTo', dateTo);
		setCsv('searchIn', searchIn);
		if (hasAttachments === 'true' || hasAttachments === 'false') {
			params.set('hasAttachments', hasAttachments);
		}
		if (sort !== 'date_desc') params.set('sort', sort);
		return params;
	}

	const buildPageUrl = (pageNum: number) => `/dashboard/search?${buildSearchParams(pageNum)}`;

	const strategies = [
		{ value: 'last', label: $t('app.search.strategy_fuzzy') },
		{ value: 'all', label: $t('app.search.strategy_verbatim') },
		{ value: 'frequency', label: $t('app.search.strategy_frequency') },
	];

	const triggerContent = $derived(
		strategies.find((s) => s.value === matchingStrategy)?.label ??
			$t('app.search.select_strategy')
	);

	/** Filters only (not the keyword or strategy), for the mobile trigger badge. */
	const activeFilterCount = $derived(
		[
			selectedSources.length > 0,
			excludedSources.length > 0,
			fromAddresses.length > 0,
			notFromAddresses.length > 0,
			toAddresses.length > 0,
			notToAddresses.length > 0,
			mailboxes.length > 0,
			mailboxPaths.length > 0,
			!!dateFrom || !!dateTo,
			searchIn.length > 0,
			hasAttachments !== 'any',
			sort !== 'date_desc',
		].filter(Boolean).length
	);

	/** Facet values plus anything already selected, so a deep link never hides its own filter. */
	const folderOptions = $derived(
		[...new Set([...(data.availableFolders ?? []), ...mailboxPaths])].sort((a, b) =>
			a.localeCompare(b)
		)
	);

	let mobileFiltersOpen = $state(false);

	/** Filters only; the keyword and strategy stay as they are. */
	function clearFilters() {
		selectedSources = [];
		excludedSources = [];
		fromAddresses = [];
		notFromAddresses = [];
		toAddresses = [];
		notToAddresses = [];
		mailboxes = [];
		mailboxPaths = [];
		dateFrom = '';
		dateTo = '';
		searchIn = [];
		hasAttachments = 'any';
		sort = 'date_desc';
		mobileFiltersOpen = false;
		goto(buildPageUrl(1), { keepFocus: true });
	}

	const isSearchNavigation = $derived(navigating.to?.url.pathname === '/dashboard/search');
	// --- Bulk deletion ---
	let selectedIds = $state<string[]>([]);
	let isDeleteDialogOpen = $state(false);
	let deleteMode = $state<'selected' | 'all'>('selected');
	let isDeleting = $state(false);
	let deleteDone = $state(0);
	let deleteTotal = $state(0);
	let deleteReport = $state<null | {
		deleted: number;
		blocked: number;
		failed: { id: string; message: string }[];
	}>(null);

	const resultHits = $derived(searchResult?.hits ?? []);
	const pageIds = $derived(resultHits.map((hit) => hit.id));
	const allOnPageSelected = $derived(
		pageIds.length > 0 && pageIds.every((id) => selectedIds.includes(id))
	);
	const someOnPageSelected = $derived(pageIds.some((id) => selectedIds.includes(id)));
	const selectedHits = $derived(resultHits.filter((hit) => selectedIds.includes(hit.id)));
	const selectedFolders = $derived([
		...new Set(
			selectedHits
				.map((hit) => hit.mailboxPath)
				.filter((path): path is string => typeof path === 'string' && path !== '')
		),
	]);
	const selectedFoldersLabel = $derived(
		selectedFolders.length > 0 ? selectedFolders.join(', ') : $t('app.search.unknown_folder')
	);

	/** Same glob rules as the backend folder filter (`*`, `?`; case-insensitive by default). */
	function folderPatternMatches(path: string, pattern: string, caseSensitive: boolean): boolean {
		let source = '^';
		for (const character of pattern) {
			if (character === '*') source += '.*';
			else if (character === '?') source += '.';
			else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		}
		source += '$';
		return new RegExp(source, caseSensitive ? '' : 'i').test(path);
	}

	/**
	 * Warn when the source will archive the folder again on the next full sync. No filter,
	 * an unknown path or an `exclude` filter that does not cover it all mean it comes back;
	 * in `include` mode the opposite is true.
	 */
	const mayReturnOnNextSync = $derived(
		selectedHits.some((hit) => {
			const source = data.ingestionSources?.find(
				(entry) => entry.id === hit.ingestionSourceId
			);
			const filter = source?.folderFilters;
			if (!filter || !hit.mailboxPath) return true;
			const matches = filter.folders.some((pattern) =>
				folderPatternMatches(
					hit.mailboxPath as string,
					pattern,
					filter.caseSensitive === true
				)
			);
			return filter.mode === 'include' ? matches : !matches;
		})
	);

	/** The same warning for "delete every result in these folders", where no hit is loaded. */
	const pathsMayReturn = $derived.by(() => {
		if (mailboxPaths.length === 0) return false;
		const sources = data.ingestionSources ?? [];
		return mailboxPaths.some((path) =>
			sources.some((source) => {
				const filter = source.folderFilters;
				if (!filter) return true;
				const matches = filter.folders.some((pattern) =>
					folderPatternMatches(path, pattern, filter.caseSensitive === true)
				);
				return filter.mode === 'include' ? matches : !matches;
			})
		);
	});

	const deleteDialogTitle = $derived(
		deleteMode === 'all'
			? $t('app.search.delete_all_title', {
					count: deleteTotal || searchResult?.total || 0,
					folders: mailboxPaths.join(', ') || $t('app.search.all_folders'),
				} as any)
			: $t('app.search.delete_dialog_title', {
					count: deleteTotal || selectedIds.length,
				} as any)
	);

	const deleteDialogFolders = $derived(
		deleteMode === 'all'
			? mailboxPaths.join(', ') || $t('app.search.all_folders')
			: selectedFoldersLabel
	);

	const deleteWarning = $derived(deleteMode === 'all' ? pathsMayReturn : mayReturnOnNextSync);

	const sleep = (milliseconds: number) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds));

	/** A new search result starts with nothing selected. */
	let lastSearchKey = $state('');
	$effect(() => {
		const key = JSON.stringify([data.keywords, data.page, data.filterParams]);
		if (key !== lastSearchKey) {
			lastSearchKey = key;
			selectedIds = [];
		}
	});

	const toggleSelected = (id: string, checked: boolean) => {
		selectedIds = checked
			? selectedIds.includes(id)
				? selectedIds
				: [...selectedIds, id]
			: selectedIds.filter((entry) => entry !== id);
	};

	const toggleSelectPage = (checked: boolean) => {
		selectedIds = checked
			? [...new Set([...selectedIds, ...pageIds])]
			: selectedIds.filter((id) => !pageIds.includes(id));
	};

	const clearSelection = () => {
		selectedIds = [];
	};

	const openDeleteSelected = () => {
		deleteMode = 'selected';
		deleteTotal = selectedIds.length;
		isDeleteDialogOpen = true;
	};

	const openDeleteAllInFolders = () => {
		if (mailboxPaths.length === 0) return;
		deleteMode = 'all';
		deleteTotal = searchResult?.total ?? 0;
		isDeleteDialogOpen = true;
	};

	const confirmDelete = async () => {
		isDeleting = true;
		deleteDone = 0;
		deleteReport = null;

		if (deleteMode === 'all') {
			await deleteAllInFolders();
			return;
		}

		const ids = [...selectedIds];
		deleteTotal = ids.length;
		const report: {
			deleted: number;
			blocked: number;
			failed: { id: string; message: string }[];
		} = { deleted: 0, blocked: 0, failed: [] };

		for (const id of ids) {
			try {
				const response = await api(`/archived-emails/${id}`, { method: 'DELETE' });
				if (response.ok) {
					report.deleted++;
				} else {
					const body = (await response.json().catch(() => ({}))) as {
						message?: string;
					};
					const message = body.message ?? `HTTP ${response.status}`;
					if (response.status === 400 && /retention policy|legal hold/i.test(message)) {
						report.blocked++;
					} else {
						report.failed.push({ id, message });
					}
				}
			} catch (error) {
				report.failed.push({
					id,
					message: error instanceof Error ? error.message : 'unknown error',
				});
			}
			deleteDone++;
		}

		deleteReport = report;
		selectedIds = [];
		isDeleteDialogOpen = false;
		isDeleting = false;
		await invalidateAll();
	};

	/**
	 * Starts the server-side bulk job and polls it until it finishes. The job keeps running if
	 * the tab closes; only the progress display is lost then.
	 */
	const deleteAllInFolders = async () => {
		try {
			const response = await api('/archived-emails/bulk-delete', {
				method: 'POST',
				body: JSON.stringify({ mailboxPaths }),
			});
			const body = (await response.json().catch(() => ({}))) as {
				id?: string;
				total?: number;
				status?: string;
				deleted?: number;
				blocked?: number;
				errors?: { id: string; message: string }[];
				message?: string;
			};

			if (!response.ok || !body.id) {
				deleteReport = {
					deleted: 0,
					blocked: 0,
					failed: [{ id: '-', message: body.message ?? `HTTP ${response.status}` }],
				};
				return;
			}

			deleteTotal = body.total ?? 0;
			if (body.status === 'completed') {
				deleteReport = {
					deleted: body.deleted ?? 0,
					blocked: body.blocked ?? 0,
					failed: body.errors ?? [],
				};
				return;
			}

			for (;;) {
				await sleep(1000);
				const poll = await api(`/archived-emails/bulk-delete/${body.id}`);
				if (!poll.ok) {
					deleteReport = {
						deleted: 0,
						blocked: 0,
						failed: [{ id: body.id, message: `HTTP ${poll.status}` }],
					};
					return;
				}
				const progress = (await poll.json()) as {
					total: number;
					done: number;
					deleted: number;
					blocked: number;
					failed: number;
					errors: { id: string; message: string }[];
					status: 'running' | 'completed';
				};
				deleteTotal = progress.total;
				deleteDone = progress.done;
				if (progress.status === 'completed') {
					deleteReport = {
						deleted: progress.deleted,
						blocked: progress.blocked,
						failed: progress.errors,
					};
					break;
				}
			}
		} catch (error) {
			deleteReport = {
				deleted: 0,
				blocked: 0,
				failed: [
					{
						id: '-',
						message: error instanceof Error ? error.message : 'unknown error',
					},
				],
			};
		} finally {
			selectedIds = [];
			isDeleteDialogOpen = false;
			isDeleting = false;
			await invalidateAll();
		}
	};

	$effect(() => {
		if (!mobileFiltersOpen) return;
		const onKeydown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') mobileFiltersOpen = false;
		};
		window.addEventListener('keydown', onKeydown);
		return () => window.removeEventListener('keydown', onKeydown);
	});

	let isMounted = $state(false);
	onMount(() => {
		isMounted = true;
	});

	// Escape all HTML, then restore only Meilisearch's <em> highlight tags. Prevents
	// XSS from attacker-controlled field content (subjects, addresses, attachment names)
	// that is otherwise injected verbatim via innerHTML below.
	function highlightToSafeHtml(html: string): string {
		const escaped = html
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
		return escaped.replace(/&lt;(\/?)em&gt;/g, '<$1em>');
	}

	function shadowRender(node: HTMLElement, html: string | undefined) {
		if (html === undefined) return;

		const shadow = node.attachShadow({ mode: 'open' });
		const style = document.createElement('style');
		style.textContent = `em { background-color: #fde047; font-style: normal; color: #1f2937; }`; // yellow-300, gray-800
		shadow.appendChild(style);
		const content = document.createElement('div');
		content.innerHTML = highlightToSafeHtml(html);
		shadow.appendChild(content);

		return {
			update(newHtml: string | undefined) {
				if (newHtml === undefined) return;
				content.innerHTML = highlightToSafeHtml(newHtml);
			},
		};
	}

	function handleSearch(e: SubmitEvent) {
		e.preventDefault();
		mobileFiltersOpen = false;
		goto(buildPageUrl(1), { keepFocus: true });
	}

	/** Resets keywords, matching strategy, and every advanced filter, then returns to the
	 *  empty search page. Wired to the no-results empty state. */
	function clearSearch() {
		keywords = '';
		matchingStrategy = 'last';
		selectedSources = [];
		excludedSources = [];
		fromAddresses = [];
		notFromAddresses = [];
		toAddresses = [];
		notToAddresses = [];
		mailboxes = [];
		mailboxPaths = [];
		dateFrom = '';
		dateTo = '';
		searchIn = [];
		hasAttachments = 'any';
		sort = 'date_desc';
		goto('/dashboard/search');
	}

	function getHighlightedSnippets(text: string | undefined, snippetLength = 80): string[] {
		if (!text || !text.includes('<em>')) {
			return [];
		}

		const snippets: string[] = [];
		const regex = /<em>.*?<\/em>/g;
		let match;
		let lastIndex = 0;

		while ((match = regex.exec(text)) !== null) {
			if (match.index < lastIndex) {
				continue;
			}

			const matchIndex = match.index;
			const matchLength = match[0].length;

			const start = Math.max(0, matchIndex - snippetLength);
			const end = Math.min(text.length, matchIndex + matchLength + snippetLength);

			lastIndex = end;

			let snippet = text.substring(start, end);

			// Then, balance them
			const openCount = (snippet.match(/<em/g) || []).length;
			const closeCount = (snippet.match(/<\/em>/g) || []).length;

			if (openCount > closeCount) {
				snippet += '</em>';
			}

			if (closeCount > openCount) {
				snippet = '<em>' + snippet;
			}

			// Finally, add ellipsis
			if (start > 0) {
				snippet = '...' + snippet;
			}
			if (end < text.length) {
				snippet += '...';
			}

			snippets.push(snippet);
		}

		return snippets;
	}
</script>

<svelte:head>
	<title>{$t('app.search.title')} | Open Archiver</title>
	<meta name="description" content={$t('app.search.description')} />
</svelte:head>

<div class="container mx-auto p-4 md:p-8">
	<div class="mb-4 flex flex-wrap items-center justify-between gap-2">
		<h1 class="text-2xl font-bold">{$t('app.search.email_search')}</h1>
		<Button
			type="button"
			variant="outline"
			class="lg:hidden"
			onclick={() => (mobileFiltersOpen = true)}
		>
			<SlidersHorizontal class="mr-2 size-4" />
			{$t('app.search.filters_button')}
			{#if activeFilterCount > 0}
				<Badge variant="secondary" class="ml-2">{activeFilterCount}</Badge>
			{/if}
		</Button>
	</div>

	<form onsubmit={handleSearch}>
		<div class="mb-6 flex items-center gap-2">
			<Input
				type="search"
				name="keywords"
				placeholder={$t('app.search.placeholder')}
				class="h-12 flex-grow"
				bind:value={keywords}
			/>
			<Button type="submit" class="h-12 cursor-pointer"
				>{$t('app.search.search_button')}</Button
			>
		</div>

		{#snippet filterPanel(withSubmit: boolean)}
			<div class="space-y-3">
				<div class="space-y-1.5">
					<div class="text-xs font-medium">{$t('app.search.search_options')}</div>
					<Select.Root
						type="single"
						name="matchingStrategy"
						bind:value={matchingStrategy}
					>
						<Select.Trigger class="w-full cursor-pointer">
							{triggerContent}
						</Select.Trigger>
						<Select.Content>
							{#each strategies as strategy (strategy.value)}
								<Select.Item
									value={strategy.value}
									label={strategy.label}
									class="cursor-pointer"
								>
									{strategy.label}
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
				<AdvancedSearchPanel
					availableSources={data.ingestionSources}
					availableFolders={folderOptions}
					bind:selectedSources
					bind:excludedSources
					bind:fromAddresses
					bind:notFromAddresses
					bind:toAddresses
					bind:notToAddresses
					bind:mailboxes
					bind:mailboxPaths
					bind:dateFrom
					bind:dateTo
					bind:searchIn
					bind:hasAttachments
					bind:sort
				/>
				{#if withSubmit}
					<Button type="submit" class="w-full cursor-pointer">
						{$t('app.search.search_button')}
					</Button>
				{/if}
			</div>
		{/snippet}

		<div class="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
			<aside
				class="hidden space-y-3 lg:sticky lg:top-6 lg:block lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:pr-1"
			>
				{@render filterPanel(true)}
			</aside>

			<div class="min-w-0">
				{#if isSearchNavigation}
					<div
						class="grid gap-4"
						aria-busy="true"
						aria-label={$t('app.search.loading_results')}
					>
						{#each [1, 2, 3] as card (card)}
							<div class="rounded-lg border p-4">
								<Skeleton class="mb-3 h-5 w-2/3" />
								<Skeleton class="mb-2 h-4 w-1/2" />
								<Skeleton class="mb-2 h-4 w-full" />
								<Skeleton class="h-4 w-5/6" />
							</div>
						{/each}
					</div>
				{:else}
					{#if error}
						<Alert.Root variant="destructive">
							<CircleAlertIcon class="size-4" />
							<Alert.Title>{$t('app.search.error')}</Alert.Title>
							<Alert.Description>{error}</Alert.Description>
						</Alert.Root>
					{/if}

					{#if deleteReport}
						<Alert.Root class="mb-4">
							<Alert.Title>{$t('app.search.delete_report_title')}</Alert.Title>
							<Alert.Description>
								<ul class="list-disc space-y-0.5 pl-4">
									<li>
										{$t('app.search.delete_report_deleted', {
											count: deleteReport.deleted,
										} as any)}
									</li>
									{#if deleteReport.blocked > 0}
										<li>
											{$t('app.search.delete_report_blocked', {
												count: deleteReport.blocked,
											} as any)}
										</li>
									{/if}
									{#if deleteReport.failed.length > 0}
										<li>
											{$t('app.search.delete_report_failed', {
												count: deleteReport.failed.length,
											} as any)}
											<ul class="list-disc pl-4">
												{#each deleteReport.failed as failure (failure.id)}
													<li class="break-all">
														{failure.id}: {failure.message}
													</li>
												{/each}
											</ul>
										</li>
									{/if}
								</ul>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									class="mt-2 h-7 px-2"
									onclick={() => (deleteReport = null)}
								>
									{$t('app.components.common.cancel')}
								</Button>
							</Alert.Description>
						</Alert.Root>
					{/if}

					{#if searchResult}
						{#if searchResult.total > 0}
							{#if selectedIds.length > 0}
								<div
									class="bg-background sticky top-2 z-10 mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2 shadow-sm"
								>
									<span class="text-sm font-medium">
										{$t('app.search.selection_count', {
											count: selectedIds.length,
										} as any)}
									</span>
									<div class="flex gap-1">
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onclick={clearSelection}
										>
											{$t('app.search.clear_selection')}
										</Button>
										<Button
											type="button"
											variant="destructive"
											size="sm"
											onclick={openDeleteSelected}
										>
											{$t('app.search.delete_selected')}
										</Button>
									</div>
								</div>
							{/if}

							<div class="mb-4 flex flex-wrap items-center justify-between gap-2">
								<div class="flex items-center gap-2">
									<Checkbox
										checked={allOnPageSelected}
										indeterminate={someOnPageSelected && !allOnPageSelected}
										onCheckedChange={(checked) =>
											toggleSelectPage(checked === true)}
										aria-label={$t('app.search.select_all_on_page', {
											count: pageIds.length,
										} as any)}
									/>
									<span class="text-muted-foreground text-sm">
										{$t('app.search.select_all_on_page', {
											count: pageIds.length,
										} as any)}
									</span>
								</div>
								<p class="text-muted-foreground">
									{$t('app.search.found_results_in', {
										total: searchResult.total,
										seconds: searchResult.processingTimeMs / 1000,
									} as any)}
								</p>
								{#if mailboxPaths.length > 0 && searchResult.total > 0}
									<Button
										type="button"
										variant="destructive"
										size="sm"
										onclick={openDeleteAllInFolders}
									>
										{$t('app.search.delete_all_in_folders', {
											count: searchResult.total,
										} as any)}
									</Button>
								{/if}
								{#if activeFilterCount > 0}
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onclick={clearFilters}
									>
										<X class="mr-1 size-3" />
										{$t('app.search.clear_filters')}
									</Button>
								{/if}
							</div>

							<div class="grid gap-4">
								{#each searchResult.hits as hit}
									{@const _formatted = hit._formatted || {}}
									<div class="flex items-start gap-3">
										<Checkbox
											class="mt-1"
											checked={selectedIds.includes(hit.id)}
											onCheckedChange={(checked) =>
												toggleSelected(hit.id, checked === true)}
											aria-label={$t('app.search.select_result')}
										/>
										<a
											href="/dashboard/archived-emails/{hit.id}"
											class="block min-w-0 flex-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
										>
											<Card>
												<CardHeader>
													<CardTitle>
														{#if !isMounted}
															<Skeleton class="h-6 w-3/4" />
														{:else}
															<div
																use:shadowRender={_formatted.subject ||
																	hit.subject}
															></div>
														{/if}
													</CardTitle>
													<div
														class="flex flex-wrap items-center gap-2 pt-1"
													>
														{#if hit.mailboxPath}
															<Badge variant="secondary">
																{$t('app.search.folder')}: {hit.mailboxPath}
															</Badge>
														{/if}
														{#if hit.hasAttachments}
															<Badge variant="outline">
																<Paperclip class="mr-1 size-3" />
																{$t('app.search.attachment_badge')}
															</Badge>
														{/if}
													</div>
													<CardDescription
														class="divide-forground flex flex-wrap items-center gap-x-2 gap-y-1 divide-x"
													>
														<span class="pr-2">
															<span>{$t('app.search.from')}:</span>
															{#if !isMounted}
																<span
																	class="bg-accent h-4 w-40 animate-pulse rounded-md"
																></span>
															{:else}
																<span
																	class="inline-block"
																	use:shadowRender={_formatted.fromName ||
																		hit.fromName ||
																		_formatted.from ||
																		hit.from}
																></span>
															{/if}
														</span>
														<span class="pr-2">
															<span>{$t('app.search.mailbox')}:</span>
															{#if !isMounted}
																<span
																	class="bg-accent h-4 w-40 animate-pulse rounded-md"
																></span>
															{:else}
																<span class="inline-block"
																	>{hit.userEmail}</span
																>
															{/if}
														</span>
														<span class="pr-2">
															{#if !isMounted}
																<span
																	class="bg-accent h-4 w-40 animate-pulse rounded-md"
																></span>
															{:else}
																<span class="inline-block">
																	{$formatDateTimeStore(
																		hit.timestamp
																	)}
																</span>
															{/if}
														</span>
													</CardDescription>
												</CardHeader>
												<CardContent class="space-y-2">
													{#if _formatted.body}
														{#each getHighlightedSnippets(_formatted.body) as snippet}
															<div
																class="space-y-2 rounded-md bg-slate-100 p-2 dark:bg-slate-800"
															>
																<p class="text-sm text-gray-500">
																	{$t(
																		'app.search.in_email_body'
																	)}:
																</p>
																{#if !isMounted}
																	<Skeleton
																		class="my-2 h-5 w-full bg-gray-200"
																	/>
																{:else}
																	<p
																		class="font-mono text-sm"
																		use:shadowRender={snippet}
																	></p>
																{/if}
															</div>
														{/each}
													{/if}

													{#if _formatted.attachments}
														{#each _formatted.attachments as attachment, i (i)}
															{@const filenameHtml =
																attachment?.filename ?? ''}
															{@const nameHit =
																filenameHtml.includes('<em>')}
															{@const contentSnippets =
																attachment?.content
																	? getHighlightedSnippets(
																			attachment.content
																		)
																	: []}
															{#if attachment && (nameHit || contentSnippets.length > 0)}
																<div
																	class="space-y-2 rounded-md bg-slate-100 p-2 dark:bg-slate-800"
																>
																	<p
																		class="flex flex-wrap items-center gap-1 text-sm text-gray-500"
																	>
																		<Paperclip
																			class="size-3.5 shrink-0"
																		/>
																		<span
																			>{$t(
																				'app.search.in_attachment_label'
																			)}:</span
																		>
																		{#if !isMounted}
																			<Skeleton
																				class="h-4 w-40 bg-gray-200"
																			/>
																		{:else}
																			<span
																				class="text-foreground break-all font-medium"
																				use:shadowRender={filenameHtml}
																			></span>
																		{/if}
																	</p>
																	{#each contentSnippets as snippet}
																		{#if !isMounted}
																			<Skeleton
																				class="my-2 h-5 w-full bg-gray-200"
																			/>
																		{:else}
																			<p
																				class="font-mono text-sm"
																				use:shadowRender={snippet}
																			></p>
																		{/if}
																	{/each}
																</div>
															{/if}
														{/each}
													{/if}
												</CardContent>
											</Card>
										</a>
									</div>
								{/each}
							</div>

							{#if searchResult.total > searchResult.limit}
								<div class="mt-8">
									<Pagination.Root
										count={searchResult.total}
										perPage={searchResult.limit}
										{page}
									>
										{#snippet children({ pages, currentPage })}
											<Pagination.Content>
												<Pagination.Item>
													<a href={buildPageUrl(currentPage - 1)}>
														<Pagination.PrevButton>
															<ChevronLeft class="h-4 w-4" />
															<span class="hidden sm:block"
																>{$t('app.search.prev')}</span
															>
														</Pagination.PrevButton>
													</a>
												</Pagination.Item>
												{#each pages as page (page.key)}
													{#if page.type === 'ellipsis'}
														<Pagination.Item>
															<Pagination.Ellipsis />
														</Pagination.Item>
													{:else}
														<Pagination.Item>
															<a href={buildPageUrl(page.value)}>
																<Pagination.Link
																	{page}
																	isActive={currentPage ===
																		page.value}
																>
																	{page.value}
																</Pagination.Link>
															</a>
														</Pagination.Item>
													{/if}
												{/each}
												<Pagination.Item>
													<a href={buildPageUrl(currentPage + 1)}>
														<Pagination.NextButton>
															<span class="hidden sm:block"
																>{$t('app.search.next')}</span
															>
															<ChevronRight class="h-4 w-4" />
														</Pagination.NextButton>
													</a>
												</Pagination.Item>
											</Pagination.Content>
										{/snippet}
									</Pagination.Root>
								</div>
							{/if}
						{:else}
							<EmptyStateIcon
								icon={SearchX}
								header={$t('app.search.no_results_title')}
								text={$t('app.search.no_results_text')}
								buttonText={$t('app.search.clear_search')}
								click={clearSearch}
							/>
						{/if}
					{:else if !error}
						<EmptyStateIcon
							icon={Search}
							header={$t('app.search.search_prompt_title')}
							text={$t('app.search.search_prompt_text')}
						/>
					{/if}
				{/if}
			</div>
		</div>

		{#if mobileFiltersOpen}
			<div class="fixed inset-0 z-50 lg:hidden">
				<button
					type="button"
					class="absolute inset-0 bg-black/50"
					aria-label={$t('app.search.close_filters')}
					onclick={() => (mobileFiltersOpen = false)}
				></button>
				<div
					class="bg-background absolute inset-y-0 right-0 flex w-[min(92vw,26rem)] flex-col border-l shadow-xl"
					role="dialog"
					aria-modal="true"
					aria-label={$t('app.search.filters_button')}
				>
					<div class="flex items-center justify-between border-b p-4">
						<h2 class="text-lg font-semibold">
							{$t('app.search.filters_button')}
							{#if activeFilterCount > 0}
								<Badge variant="secondary" class="ml-2">{activeFilterCount}</Badge>
							{/if}
						</h2>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							aria-label={$t('app.search.close_filters')}
							onclick={() => (mobileFiltersOpen = false)}
						>
							<X class="size-4" />
						</Button>
					</div>
					<div class="flex-1 overflow-y-auto p-4">
						{@render filterPanel(false)}
						<Button type="submit" class="mt-4 w-full">
							{$t('app.search.search_button')}
						</Button>
					</div>
				</div>
			</div>
		{/if}
	</form>

	<Dialog.Root bind:open={isDeleteDialogOpen}>
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>
					{deleteDialogTitle}
				</Dialog.Title>
				<Dialog.Description>
					{$t('app.search.delete_dialog_description')}
				</Dialog.Description>
			</Dialog.Header>

			<div class="space-y-3 py-2">
				<p class="text-sm">
					{$t('app.search.delete_dialog_folders', {
						folders: deleteDialogFolders,
					} as any)}
				</p>
				{#if deleteWarning}
					<Alert.Root variant="destructive">
						<Alert.Description>
							{$t('app.search.delete_dialog_return_warning')}
						</Alert.Description>
					</Alert.Root>
				{/if}
				{#if deleteMode === 'all' && !isDeleting}
					<p class="text-muted-foreground text-xs">
						{$t('app.search.delete_all_background_note')}
					</p>
				{/if}
				{#if isDeleting}
					<Progress value={deleteTotal > 0 ? (deleteDone / deleteTotal) * 100 : 0} />
					<p class="text-muted-foreground text-sm">
						{$t('app.search.delete_progress', {
							done: deleteDone,
							total: deleteTotal,
						} as any)}
					</p>
				{/if}
			</div>

			<Dialog.Footer>
				<Button
					type="button"
					variant="outline"
					disabled={isDeleting}
					onclick={() => (isDeleteDialogOpen = false)}
				>
					{$t('app.components.common.cancel')}
				</Button>
				<Button
					type="button"
					variant="destructive"
					disabled={isDeleting || (deleteMode === 'selected' && selectedIds.length === 0)}
					onclick={confirmDelete}
				>
					{deleteMode === 'all'
						? $t('app.search.delete_all_confirm')
						: $t('app.search.delete_selected')}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
</div>
