# OpenArchiver Slim — fork notes

This is an **unofficial fork** of
[LogicLabs-OU/OpenArchiver](https://github.com/LogicLabs-OU/OpenArchiver), based on upstream
`v0.6.2` (AGPL-3.0). The fork lives at
[iwanzarembo/OpenArchiver](https://github.com/iwanzarembo/OpenArchiver). It is not affiliated
with or endorsed by the upstream project.

## What this fork adds

Everything in this list is additive: without a folder filter and without using the new actions,
the behaviour is the same as upstream.

| Area         | Change                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ingestion    | Per-source folder filters (`folderFilters`): `exclude` keeps the historic selection and removes the named folders, `include` archives only the named folders. `*`/`?` globs, optional case sensitivity, paths use the provider's delimiter. |
| Ingestion UI | A folder picker that loads the real mailbox folders, renders them as a tree, grays out `\Noselect`, and pre-fills the saved filter when editing.                                                                                            |
| Search       | `mailboxPath` in the index, `mailboxPaths` filter, folder facet and typeahead.                                                                                                                                                              |
| Search UI    | Mobile-friendly page with a filter sheet, folder multi-select, result cards, deep links, skeleton/error/empty states.                                                                                                                       |
| Deletion     | Bulk delete of the selected results and a **server-side job** that deletes every archived email in whole folders, with progress, legal-hold reporting and a final report.                                                                   |
| Viewer       | HTML is sanitized with DOMPurify; external images/iframes/objects/CSS URLs are stripped by default behind a “Load external images” switch; tracking-pixel hint; sandboxed iframe.                                                           |

The schema change is a single nullable column (`ingestion_sources.folder_filters`), so upgrading an
existing instance does not rewrite data.

## Images

GHCR is the primary registry:

```text
ghcr.io/iwanzarembo/open-archiver:v0.6.2-slim.1   # immutable release
ghcr.io/iwanzarembo/open-archiver:slim           # moving fork tag
```

Docker Hub can be mirrored under the same digest:

```text
iwzr/open-archiver:v0.6.2-slim.1
iwzr/open-archiver:slim
```

`v0.6.2` is the upstream base, `slim` identifies this feature set, `.1` is the fork revision.
Avoid deploying `latest` for reproducible installations; pin a release tag or digest.

### Run

```bash
docker pull ghcr.io/iwanzarembo/open-archiver:v0.6.2-slim.1
docker run -d --name open-archiver \
  --env-file .env \
  -p 3000:3000 \
  -v /path/to/archive:/var/data/open-archiver \
  ghcr.io/iwanzarembo/open-archiver:v0.6.2-slim.1
```

The image expects the same environment as upstream (`DATABASE_URL`, `REDIS_*`, `MEILI_*`,
`STORAGE_*`, `JWT_SECRET`, `ENCRYPTION_KEY`, `APP_URL`, …). Set `ENABLE_DELETION=true` to use the
delete features. PostgreSQL, Valkey/Redis, Meilisearch and Tika are not bundled in this image; use
the upstream `docker-compose.yml` or your own services.

## Folder filters

Set them in the source dialog, or via the API:

```json
{
	"folderFilters": {
		"mode": "exclude",
		"folders": ["INBOX", "Trash", "Spam"],
		"caseSensitive": false
	}
}
```

- `exclude`: archive everything except the listed folders (the default selection still skips
  Drafts/Junk/Trash unless the corresponding environment flags enable them).
- `include`: archive **only** the listed folders. An empty list archives nothing (fail-closed).
- The filter applies to future syncs. Existing archived emails are not removed automatically.

## Folder facet and full reindex

The search facet uses `mailboxPath`, which was added to the index in this fork. After upgrading an
existing instance, run **Reindex All → Full** once; otherwise documents indexed by the old version
have no folder value and the facet stays empty. A reindex reads the archive database and stored
EML files only — it does not contact the mail server and does not delete anything.

## Deleting whole folders

Search for the folder (e.g. `mailboxPaths=INBOX`), then use **“Delete all N hits in these folders”**.
The server resolves the matching archived rows with the caller's delete permission and processes
them sequentially through the normal deletion path (storage, Meilisearch, audit log, legal holds).
The browser can be closed while it runs.

Make sure the source's folder filter excludes the folder first; otherwise the next full sync will
archive its messages again.

## License and source

Upstream and this fork are licensed under **AGPL-3.0**; `LICENSE` is unchanged. The source of every
published image is this repository. If you redistribute the image or run a modified version as a
network service, keep the corresponding source available and retain the upstream attribution.
See `NOTICE` for the upstream project and the modification summary.

## Upstream contribution plan

The backend changes are designed to be upstream-friendly (default behaviour unchanged):

1. `feat(ingestion): per-source folder filters` — types, nullable column, filter helper, tests,
   IMAP connector.
2. `feat(ingestion): folder list endpoint` — `POST /v1/ingestion-sources/folders`.
3. `feat(search): folder in index, filter and facet` — `mailboxPath`, `mailboxPaths`, reindex.

The UI changes (picker, search page, bulk delete button, viewer hardening) are more opinionated and
can follow as separate PRs or stay fork-only. Keeping the backend pieces upstream reduces the
maintenance surface of this fork.

## Build

```bash
docker build -f apps/open-archiver/Dockerfile -t open-archiver-slim:local .
```

The Dockerfile is unchanged apart from a `ci` stage that lets CI run checks against the
already-built tree; the `production` stage is the upstream image layout.
