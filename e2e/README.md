# e2e — Playwright suite

End-to-end tests for flow-controller, run against a **running** app (there is
no `webServer` block on purpose: a wrong base URL must fail loudly, not start
a second server). `playwright.config.ts` pins `http://localhost:8000`,
`workers: 1`, `retries: 1`.

## The two phases

The suite runs in two variants, matching the two phases of the `e2e` CI job:

| Phase | Container | Specs |
| --- | --- | --- |
| 1. **bare** | `docker-compose.yml` + `docker-compose.ci.yml` — no services configured | `specs/auth.spec.ts`, `specs/dashboard-bare.spec.ts` |
| 2. **stub** | + `docker-compose.e2e.yml` — `fake-arr` (Radarr stub) on the same network | `specs/flow-faltantes.spec.ts`, `specs/flow-release-search.spec.ts` |

The bare specs must keep passing against a container with **no** services:
they pin the honest empty state and the gated navigation. The stub specs pin
the headline flow: *Faltantes → buscar release → encolar*.

The two variants are **mutually exclusive** — a service-less container cannot
render the stub's rows and a stub-backed container does not show the bare
empty state — so `npm test` (all specs) has no single container to pass
against. Always run the two explicit spec lists above, as the CI job does.

## The stub: `fake-arr/`

`fake-arr/server.mjs` is a Radarr/Sonarr stub written with **only Node's
built-in `http` module** — zero dependencies, started with
`node e2e/fake-arr/server.mjs` (port `4000`, override with `PORT`). The
compose override bind-mounts the directory onto stock `node:22-alpine`, so
there is nothing to build or install. It serves the endpoints the app's arr
client actually calls (`system/status`, `movie`, `movie/{id}`,
`wanted/missing`, `indexer`, `release` GET+POST, `rootfolder`, plus valid
empties for the 15 s `/api/trace` poll), logs every request as
`METHOD path` to stdout for CI diagnosis, answers `404` + JSON for anything
unmatched, and exposes `GET /__health` for the compose healthcheck.

**Fixtures are derived from shapes captured in the backend tests** — every
field name is copied from `backend/tests_wanted_scan.py`,
`backend/tests_routes.py`, `backend/tests.py`, `backend/tests_downloads.py`,
or from the readers in `backend/clients.py`. See
`fake-arr/fixtures/README.md` for the per-file provenance table.

## Running locally

Phase 1 (bare), exactly as CI:

```sh
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d
# wait for http://localhost:8000/api/health
cd e2e && npx playwright test specs/auth.spec.ts specs/dashboard-bare.spec.ts
cd .. && docker compose -f docker-compose.yml -f docker-compose.ci.yml down -v
```

Phase 2 (stub-backed):

```sh
docker compose -f docker-compose.yml -f docker-compose.ci.yml -f docker-compose.e2e.yml up -d
# wait for :8000/api/health AND :4400/__health (stub is published on 127.0.0.1:4400)
cd e2e && npx playwright test specs/flow-faltantes.spec.ts specs/flow-release-search.spec.ts
cd .. && docker compose -f docker-compose.yml -f docker-compose.ci.yml -f docker-compose.e2e.yml down -v
```

Without Docker, the same two phases work with host processes: run
`node e2e/fake-arr/server.mjs`, then start the backend so it serves
`frontend/dist`, e.g. for the stub phase:

```sh
CONFIG_DIR=/tmp/fc-e2e2 API_KEY=test-key DEVELOPER=false \
RADARR_URL=http://localhost:4000 RADARR_API_KEY=test-radarr-key \
  uvicorn app:app --port 8000   # from backend/
```

(fresh `CONFIG_DIR` matters: env vars only seed `settings.json` on first run —
`settings.py:migrate_env_vars`). The bare phase is the same command without
`RADARR_*`, in its own fresh `CONFIG_DIR`.

## Known limitation — a fake grab downloads nothing

`POST /api/v3/release` in the stub answers `201` and echoes the release
resource back. **No torrent is fetched, no file arrives, no queue item
appears.** The stub specs prove the *UI flow* — the right requests go out with
the right payload and the app renders the success state — not the transfer.
Proving the transfer needs a real Radarr + real indexers, which is what
`e2e/smoke/calendar-grab.sh` (manual, against a live deployment) is for.

## Conventions

- Role/accessible-name selectors only; a text selector is allowed solely where
  the markup has no ARIA role, and the spec must say so inline.
- No `waitForTimeout` — this is part of the job's promotion criterion (see the
  comment above the `e2e` job in `.github/workflows/ci.yml`).
- Web-first assertions with explicit `{ timeout: 15000 }`: the app polls at
  2–15 s and React Query retries twice.
- No `data-testid` — selectors must be strings that live in the components.
