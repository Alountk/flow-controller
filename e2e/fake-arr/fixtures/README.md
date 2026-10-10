# fake-arr fixtures — provenance

Every payload in this directory is **copied from a shape captured in this
repo** — a backend test that pinned a real response, or the exact fields
`backend/clients.py` reads off the wire. Nothing here invents field names.
JSON has no comments, so this table is where each fixture cites its source.

| Fixture | Endpoint | Shape source |
| --- | --- | --- |
| `system-status.json` | `GET /api/v3/system/status` | `backend/tests_routes.py:1543` — *TestServiceConnectionTester.a_healthy_arr_reports_its_version* (`{"appName": "Radarr", "version": "6.4.4.10685"}`); read at `backend/clients.py:161-162` |
| `wanted-missing.json` | `GET /api/v3/wanted/missing` | `backend/tests_wanted_scan.py:46-60` — *“Shape captured from a real Radarr /api/v3/wanted/missing response”* (`records` entry + `totalRecords`), plus the `overview` field from `backend/tests_routes.py:226-241` `RADARR_PAYLOAD` (wanted-route tests); read at `backend/clients.py:946-962` |
| `movies.json` | `GET /api/v3/movie` (bare array) | Fields from `backend/tests_routes.py:1205-1208` `ALL_MOVIES_PAYLOAD`; the `813` entry's identity from `backend/tests_wanted_scan.py:31-44` `MOVIE_PAYLOAD` (“captured from a real Radarr /api/v3/movie/{id}”); read at `backend/clients.py:983-1011` and iterated at `:691` |
| `movie-813.json` | `GET /api/v3/movie/{id}` | `backend/tests_wanted_scan.py:30-44` — *“Shape captured from a real Radarr /api/v3/movie/{id} response”*, verbatim; read by `arr_movie_metadata` (`backend/clients.py:519+`) and `arr_movie_root_folder` (`:451-462`) |
| `indexers.json` | `GET /api/v3/indexer` (bare array) | Field set from `backend/tests.py:777` (`id`, `name`, `implementation`, `enableSearch`) + `enableRss` from the reader defaults at `backend/clients.py:771-779`; iterated, so a bare array, not `{records}` |
| `releases.json` | `GET /api/v3/release` (bare array) | The field names are exactly what `arr_fetch_releases` reads: `backend/clients.py:1341-1363`; the nested `quality.quality.name` shape is the one documented at `backend/clients.py:1343-1347`. No backend test pins a raw release payload, so the client's reader *is* the contract. Titles/qualities are values, not field names |
| `rootfolders.json` | `GET /api/v3/rootfolder` | `backend/tests_routes.py:1398-1401` — *TestCalendarDestinations* (`[{"path": "/mnt/storage/movies"}]`); read at `backend/clients.py:799` |
| `queue-one-import-blocked.json` | `GET /api/v3/queue` | Records envelope from `backend/tests_downloads.py:59`; **field names are exactly what the readers use**: `traces.py` (queue join: `downloadId`, `trackedDownloadState`/`Status`, `outputPath`, `statusMessages`) and `application/use_cases/downloads_cache.py:_build_download` (moved from `routes/downloads.py` by F-06e). The long `outputPath` is deliberate — `e2e/specs/kanban-fit.spec.ts` measures that the card fits its column with an unbreakable path inside it |
| `history-one-grab.json` | `GET /api/v3/history` | Same envelope; fields are what `build_traces` reads off a grab record (`downloadId`, `sourceTitle`, `date`, `movieId`, `data.indexer`). The `downloadId` matches the queue fixture on purpose: the join is what turns both into one trace row |
| `downloadclients-empty.json` | `GET /api/v3/downloadclient` | **Bare `[]`, not `{records}`**: `backend/clients.py:750` returns the body as-is and `backend/traces.py:60-68` (`dc_host_map`) iterates it as `list[dict]` |
| `series-empty.json` | `GET /api/v3/series` | **Bare `[]`, not `{records}`**: iterated at `backend/clients.py:691` (`for s in data`) and `:1031` |

Verified against the readers, not assumed: only `queue` and `history` use the
`{"records": []}` envelope; `downloadclient`, `series`, `movie` and `indexer`
are bare JSON arrays; `wanted/missing` is `{records, totalRecords}`.
