# Local development

The fork is developed on Linux (WSL2 or a Linux host). The POSIX requirement is
not optional: `packages/backend`'s `copy-assets` script uses `cp -r`, and the
pnpm symlink layout does not survive a Windows build.

## Toolchain

- Node.js >= 22 (`engines` in the root `package.json`)
- pnpm `10.34.7` (pinned as `packageManager`)

```bash
npm install -g pnpm@10.34.7
pnpm install --frozen-lockfile
```

## Development infrastructure

Start the four services from the repository's `docker-compose.yml`:

```bash
docker compose up -d postgres valkey meilisearch tika
```

The Compose file uses fixed `container_name`s. If another OpenArchiver instance
is already running on the same host, stop it or copy the services into a
separate Compose file with unique names and ports; `-p` alone does not rename
containers that set `container_name` explicitly.

Copy `.env.example` and generate the keys:

```bash
cp .env.example .env
openssl rand -hex 32   # ENCRYPTION_KEY
openssl rand -hex 32   # STORAGE_ENCRYPTION_KEY
```

Set `STORAGE_LOCAL_ROOT_PATH` to a writable directory, and `ENABLE_DELETION=true`
if you want to test the delete features. Ports `3000` (frontend) and `4000`
(backend) must be free.

## Build, migrations and tests

```bash
pnpm build:oss
pnpm db:migrate
pnpm --filter @open-archiver/backend test:unit
```

`test:unit` runs `node --test` against `packages/backend/dist`, so the backend has
to be built first. `test:integration:tika` additionally needs `TIKA_URL`.

## Dev loop

```bash
pnpm --filter @open-archiver/backend dev     # tsc --watch
pnpm start:workers:dev                       # ingestion, indexing, scheduler
pnpm --filter @open-archiver/frontend dev    # SvelteKit on :3000
```

The frontend talks to the backend on `PORT_BACKEND` (default `4000`). If port
`3000` is already in use, set `PORT_FRONTEND` (and `APP_URL`/`ORIGIN`) to a free
port before starting Vite.

## CI and image publishing

- `.github/workflows/ci.yml` runs lint, `build:oss`, the unit tests and
  `svelte-check` on GitHub-hosted runners.
- `.github/workflows/publish-image.yml` builds the production image on a `v*`
  tag and pushes it to GHCR. Docker Hub is optional and documented in
  [FORK.md](../FORK.md).
