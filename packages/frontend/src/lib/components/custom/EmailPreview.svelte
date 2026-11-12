<script lang="ts">
	import PostalMime, { type Attachment, type Email } from 'postal-mime';
	import type { Buffer } from 'buffer';
	import { browser } from '$app/environment';
	import DOMPurify from 'dompurify';
	import { Button } from '$lib/components/ui/button';
	import { t } from '$lib/translations';
	import { encode } from 'html-entities';

	let {
		raw,
		rawHtml,
	}: { raw?: Buffer | { type: 'Buffer'; data: number[] } | undefined; rawHtml?: string } =
		$props();

	let parsedEmail: Email | null = $state(null);
	let isLoading = $state(true);
	/** External images stay blocked until the reader explicitly asks for them. */
	let allowRemoteContent = $state(false);

	/** Converts an ArrayBuffer to a base64-encoded string. */
	function arrayBufferToBase64(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		for (let i = 0; i < bytes.byteLength; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	}

	/**
	 * Replaces `cid:` references in HTML with inline base64 data URIs
	 * sourced from the parsed email attachments. This ensures that images
	 * embedded as MIME parts (disposition: inline) render correctly in the
	 * iframe preview.
	 */
	function resolveContentIdReferences(html: string, attachments: Attachment[]): string {
		if (!attachments || attachments.length === 0) return html;

		const cidMap = new Map<string, string>();
		for (const attachment of attachments) {
			if (!attachment.contentId) continue;

			const cid = attachment.contentId.replace(/^<|>$/g, '');

			let base64Content: string;
			if (typeof attachment.content === 'string') {
				base64Content = attachment.content;
			} else {
				base64Content = arrayBufferToBase64(attachment.content);
			}

			cidMap.set(cid, `data:${attachment.mimeType};base64,${base64Content}`);
		}

		if (cidMap.size === 0) return html;

		return html.replace(/cid:([^\s"']+)/gi, (match, cid) => {
			return cidMap.get(cid) ?? match;
		});
	}

	/** A URL that reaches the network. `data:` and relative references stay local. */
	const isRemoteUrl = (value: string): boolean =>
		/^(?:https?:)?\/\//i.test(value.trim()) || /^https?:/i.test(value.trim());

	/**
	 * Sanitizes the mail body and removes everything that would contact a third party.
	 *
	 * DOMPurify removes scripts, event handlers and the dangerous embedding tags; the DOM pass
	 * afterwards handles the resources DOMPurify intentionally leaves alone (images, posters,
	 * `background`, CSS `url()`/`@import`). Removing them is the only reliable block: telling the
	 * browser not to load them through a policy still lets older renderers through, and a blocked
	 * `src` cannot fire a tracking pixel.
	 *
	 * Returns the number of blocked references so the banner can say what was withheld.
	 */
	function sanitizeAndBlock(
		html: string,
		allowRemote: boolean
	): { html: string; blocked: number } {
		let blocked = 0;

		const clean = DOMPurify.sanitize(html, {
			FORBID_TAGS: [
				'script',
				'iframe',
				'object',
				'embed',
				'form',
				'input',
				'button',
				'select',
				'textarea',
				'meta',
				'link',
				'base',
				'style',
			],
			FORBID_ATTR: ['srcdoc', 'formaction'],
			ALLOW_DATA_ATTR: false,
		});

		if (!browser) {
			return { html: clean, blocked };
		}

		const doc = new DOMParser().parseFromString(clean, 'text/html');

		const handleRemoteAttribute = (element: Element, attribute: string) => {
			const value = element.getAttribute(attribute);
			if (!value || !isRemoteUrl(value)) return;
			blocked++;
			if (!allowRemote) {
				element.removeAttribute(attribute);
			}
		};

		for (const element of doc.querySelectorAll(
			'img, source, video, audio, track, image, use'
		)) {
			handleRemoteAttribute(element, 'src');
			handleRemoteAttribute(element, 'href');
			handleRemoteAttribute(element, 'poster');
		}

		for (const element of doc.querySelectorAll('[srcset]')) {
			const value = element.getAttribute('srcset') ?? '';
			const kept = value
				.split(',')
				.map((entry) => entry.trim())
				.filter((entry) => entry !== '')
				.filter((entry) => {
					const url = entry.split(/\s+/)[0];
					const remote = isRemoteUrl(url);
					if (remote) blocked++;
					return allowRemote || !remote;
				});
			if (kept.length > 0) {
				element.setAttribute('srcset', kept.join(', '));
			} else {
				element.removeAttribute('srcset');
			}
		}

		for (const element of doc.querySelectorAll('[background]')) {
			const value = element.getAttribute('background') ?? '';
			if (!isRemoteUrl(value)) continue;
			blocked++;
			if (!allowRemote) element.removeAttribute('background');
		}

		for (const element of doc.querySelectorAll('[style]')) {
			const value = element.getAttribute('style') ?? '';
			if (!/url\s*\(|@import/i.test(value)) continue;
			const stripped = value
				.replace(/url\(\s*(['"]?)(?:https?:)?\/\/[^)]*\)/gi, () => {
					blocked++;
					return 'none';
				})
				.replace(/@import[^;]+;?/gi, () => {
					blocked++;
					return '';
				});
			element.setAttribute('style', stripped);
		}

		return { html: doc.body.innerHTML, blocked };
	}

	/** The mail body before sanitizing, with `cid:` images already resolved. */
	const emailSourceHtml = $derived.by(() => {
		if (parsedEmail && parsedEmail.html) {
			return resolveContentIdReferences(parsedEmail.html, parsedEmail.attachments);
		}
		if (parsedEmail && parsedEmail.text) {
			return `<div>${encode(parsedEmail.text).replaceAll('\n', '<br>')}</div>`;
		}
		if (rawHtml) {
			return rawHtml;
		}
		return null;
	});

	const sanitized = $derived.by(() => {
		if (!emailSourceHtml) return null;
		const result = sanitizeAndBlock(emailSourceHtml, allowRemoteContent);
		// `<base>` is added after sanitizing: it is trusted, and DOMPurify would remove it.
		return { html: `<base target="_blank" />${result.html}`, blocked: result.blocked };
	});

	$effect(() => {
		async function parseEmail() {
			if (raw) {
				try {
					let buffer: Uint8Array;
					if ('type' in raw && raw.type === 'Buffer') {
						buffer = new Uint8Array(raw.data);
					} else {
						buffer = new Uint8Array(raw as Buffer);
					}
					const parsed = await new PostalMime().parse(buffer);
					parsedEmail = parsed;
				} catch (error) {
					console.error('Failed to parse email:', error);
				} finally {
					isLoading = false;
				}
			} else {
				isLoading = false;
			}
		}
		parseEmail();
	});
</script>

<div class="mt-2 space-y-2">
	{#if isLoading}
		<div class="rounded-md border bg-white p-4">
			<p>{$t('app.components.email_preview.loading')}</p>
		</div>
	{:else if sanitized}
		{#if sanitized.blocked > 0}
			<div
				class="bg-muted flex flex-wrap items-start justify-between gap-2 rounded-md border p-2 text-sm"
			>
				<div>
					{#if allowRemoteContent}
						<p class="font-medium">
							{$t('app.components.email_preview.remote_allowed')}
						</p>
					{:else}
						<p class="font-medium">
							{$t('app.components.email_preview.remote_blocked', {
								count: sanitized.blocked,
							} as any)}
						</p>
					{/if}
					<p class="text-muted-foreground text-xs">
						{$t('app.components.email_preview.tracking_hint')}
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onclick={() => (allowRemoteContent = !allowRemoteContent)}
				>
					{allowRemoteContent
						? $t('app.components.email_preview.block_remote')
						: $t('app.components.email_preview.load_remote')}
				</Button>
			</div>
		{/if}

		<div class="rounded-md border bg-white p-4">
			<iframe
				title={$t('app.archive.email_preview')}
				srcdoc={sanitized.html}
				sandbox="allow-popups allow-popups-to-escape-sandbox"
				referrerpolicy="no-referrer"
				class="h-[600px] w-full border-none"
			></iframe>
		</div>
	{:else if raw}
		<div class="rounded-md border bg-white p-4">
			<p>{$t('app.components.email_preview.render_error')}</p>
		</div>
	{:else}
		<div class="rounded-md border bg-white p-4">
			<p class="text-gray-500">{$t('app.components.email_preview.not_available')}</p>
		</div>
	{/if}
</div>
