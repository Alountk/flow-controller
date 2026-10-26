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
| 2. **stub** | + `docker-compose.e2e.yml` — `fake-arr` (Radarr/Torznab/qBittorrent stub) on the same network, sources **seeded** | `specs/flow-faltantes.spec.ts`, `specs/flow-release-search.spec.ts`, `specs/kanban-fit.spec.ts` |

The bare specs must keep passing against a container with **no** services:
they pin the honest empty state and the gated navigation. The stub specs pin
the headline flow: *Faltantes → buscar release → encolar*, and that the kanban
cards fit their columns (F-09).

The two variants are **mutually exclusive** — a service-less container cannot
render the stub's rows and a stub-backed container does not show the bare
empty state — so `npm test` (all specs) has no single container to pass
against. Always run the two explicit spec lists above, as the CI job does.
The **seed** makes the split stricter, not looser: once the Torznab registry
and `services.qbit` are seeded (see *Running locally*), `dashboard-bare`'s
empty-state assertion is already false, and stacking every spec onto one
seeded instance also trips the auth rate limit — an HTTP `429` that looks like
a broken spec but is just too many authed calls too fast. So phase 1 runs on
the bare instance, **before** any seed; phase 2 runs after it.

## The stub: `fake-arr/`

`fake-arr/server.mjs` is a Radarr/Sonarr/**Torznab**/**qBittorrent** stub
written with **only Node's built-in `http` module** — zero dependencies,
started with `node e2e/fake-arr/server.mjs` (port `4000`, override with
`PORT`). The compose override bind-mounts the directory onto stock
`node:22-alpine`, so there is nothing to build or install. It serves the
endpoints the app's arr client actually calls (`system/status`, `movie`,
`movie/{id}`, `wanted/missing`, `indexer`, `release` GET+POST, `rootfolder`,
plus valid empties for the 15 s `/api/trace` poll), **and** the two sources
S1/S2 moved the headline flow onto:

- `GET /torznab/api` — a Torznab Atom feed built from
  `fixtures/releases.json` (shape: `torznab_client.py::_parse_rows`), what the
  app's **own** Torznab registry is searched against.
- The qBittorrent Web API: `POST /api/v2/auth/login` (accepts `test`/`test`,
  answers `200 "Ok."` + SID cookie) and `POST /api/v2/torrents/add` (logs the
  `urls` + `category` form fields to stdout, answers `200 "Ok."`).

Why the stub grew those two faces: S1 moved calendar search off Radarr — the
app now fans out to its **own** Torznab registry — and S2 dispatches the grab
to the app's qBittorrent client instead of a Radarr grab. The stub answers
what the app actually calls now, so the stub specs keep pinning the full
*buscar release → encolar* flow end to end.

It logs every request as `METHOD path` to stdout for CI diagnosis, answers
`404` + JSON for anything unmatched, and exposes `GET /__health` for the
compose healthcheck.

**Fixtures are derived from shapes captured in the backend tests** — every
field name is copied from `backend/tests_wanted_scan.py`,
`backend/tests_routes.py`, `backend/tests.py`, `backend/tests_downloads.py`,
or from the readers in `backend/clients.py` (`releases.json` doubles as the
Torznab feed source: `backend/torznab_client.py::_parse_rows` reads it in Atom
form). See
`fake-arr/fixtures/README.md` for the per-file provenance table.

## Running locally

Order matters: **phase 1 before the seed, phase 2 after it** — the seed is
what turns the bare empty state off.

Phase 1 (bare), exactly as CI — before anything is seeded:

```sh
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d
# wait for http://localhost:8000/api/health
cd e2e && npx playwright test specs/auth.spec.ts specs/dashboard-bare.spec.ts
cd .. && docker compose -f docker-compose.yml -f docker-compose.ci.yml down -v
```

Then seed the app's two sources (same commands as the CI step
`Phase 2 — seed our sources (Torznab registry + qbit service)` — copy-paste
after boot):

```sh
# 1) Torznab registry row pointing at the stub's feed. 409 = a previous
#    seed already created it (idempotent re-run), anything else fails loud.
CODE=$(curl -s -o /tmp/seed-idx.json -w '%{http_code}' \
  -H "X-Api-Key: test-key" -H "Content-Type: application/json" \
  -d '{"name":"Torznab","url":"http://127.0.0.1:4400/torznab/api","api_key":"test-e2e-key","enabled":true}' \
  http://localhost:8000/api/indexers)
if [ "$CODE" = "200" ]; then echo "✅ registry seeded"
elif [ "$CODE" = "409" ]; then echo "ℹ️ registry already seeded (409)"
else echo "❌ POST /api/indexers -> HTTP $CODE"; cat /tmp/seed-idx.json; exit 1; fi
# 2) qbit service settings: GET (the payload contract IS the settings GET,
#    repo lesson: DEFAULTS["services"]) → merge services.qbit → POST back.
#    Masked secrets ride back and the endpoint restores them from current.
curl -sS -f -H "X-Api-Key: test-key" http://localhost:8000/api/settings > /tmp/settings.json \
  || { echo "❌ GET /api/settings"; exit 1; }
jq '.services.qbit = {"url":"http://127.0.0.1:4400","user":"test","password":"test"}' \
  /tmp/settings.json > /tmp/settings-seed.json \
  || { echo "❌ jq merge of services.qbit"; exit 1; }
curl -sS -f -X POST -H "X-Api-Key: test-key" -H "Content-Type: application/json" \
  --data-binary @/tmp/settings-seed.json http://localhost:8000/api/settings > /tmp/seed-settings.json \
  || { echo "❌ POST /api/settings"; exit 1; }
echo "✅ qbit service seeded: $(jq -c '.services.qbit' /tmp/settings-seed.json)"
```

Phase 2 (stub-backed) — after the seed:

```sh
docker compose -f docker-compose.yml -f docker-compose.ci.yml -f docker-compose.e2e.yml up -d
# wait for :8000/api/health AND :4400/__health (stub is published on 127.0.0.1:4400)
# ...then run the seed above...
cd e2e && ./node_modules/.bin/playwright test specs/flow-faltantes.spec.ts specs/flow-release-search.spec.ts specs/kanban-fit.spec.ts
cd .. && docker compose -f docker-compose.yml -f docker-compose.ci.yml -f docker-compose.e2e.yml down -v
```

Do **not** re-run the bare specs against the seeded instance: it breaks
`dashboard-bare`'s empty-state assertion, and stacking every spec onto one
seeded app can trip the auth rate limit (HTTP `429`).

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
`RADARR_*`, in its own fresh `CONFIG_DIR`, and the stub phase still needs the
seed curls above after boot (they only need `localhost:8000` and work the
same against a host process).

## Known limitation — a fake grab downloads nothing

`POST /api/v3/release` in the stub answers `201` and echoes the release
resource back, and `POST /api/v2/torrents/add` (qBittorrent) logs the
`urls` + `category` it received and answers `"Ok."`. **No torrent is fetched,
no file arrives, no queue item appears** — on either path. The stub specs
prove the *UI flow* — the right requests go out with the right payload and the
app renders the success state — not the transfer. Proving the transfer needs
a real Radarr + real indexers (or a real qBittorrent), which is what
`e2e/smoke/calendar-grab.sh` (manual, against a live deployment) is for.

## Conventions

- Role/accessible-name selectors only; a text selector is allowed solely where
  the markup has no ARIA role, and the spec must say so inline.
- No `waitForTimeout` — this is part of the job's promotion criterion (see the
  comment above the `e2e` job in `.github/workflows/ci.yml`).
- Web-first assertions with explicit `{ timeout: 15000 }`: the app polls at
  2–15 s and React Query retries twice.
- No `data-testid` — selectors must be strings that live in the components.
