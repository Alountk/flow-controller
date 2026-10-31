# Feature: ffprobe-masivo (roadmap «Calidad de biblioteca» A)

ODD feature doc. Ships bulk ffprobe analysis over the whole library, persisted
probe results (so repeated analysis never pays ffprobe twice), and the
per-file «baja calidad» chip rendered only from analyzed data.

## Specs

- **S1 — Persistencia de resultados ffprobe.** Every successful probe is
  stored in sqlite keyed by the file's identity (path + mtime + size).
  Re-analysis of a file whose mtime/size still match answers from the
  database without spawning ffprobe («los datos de analisis de los archivos,
  más que nada para ahorrarnos ffprobe»). A file whose mtime or size changed
  is stale: it must be re-probed before its stored data is trusted or served.
  Probe rows hold the FULL parsed payload the existing `parse_probe_data`
  emits (keys always present, sentinels `unknown`/0/-999→0 rules unchanged) —
  no reshaping, no second schema of truth. A failed probe is never persisted.
- **S2 — Chip «Baja calidad» por fichero.** The file sections show a
  «Baja calidad» chip for a file **only when it has been analyzed** (fresh
  persisted data) and its probe height is below 1080 (threshold = the
  roadmap default «menos de 1080p»). Un-analyzed files show no chip — the
  honesty pin from the roadmap («chip solo tras analizar») holds: the chip
  must never be inferred from the filename. Chip state comes from the
  database, never from a probe triggered by rendering (zero probes on
  render remains a hard rule).
- **S3 — Análisis masivo de biblioteca con skip.** An on-demand server job
  walks the whole file universe: every movie folder from the catalogue
  (`GET /api/wanted/all`, `movie.path`) plus the routing folders
  (`paths.path_4k`, `paths.path_3d` from `GET /api/settings`). For each
  video file: fresh persisted row → skipped («si los datos existen …
  skipear los archivos que ya estan pasados»); no/stale row → ffprobe and
  persist. A failing file is counted and reported, never aborts the run.
  Only ONE run at a time (a second start while running answers 409).
  Progress is readable from a status endpoint: running flag, totals,
  analyzed / skipped / failed counts and the last terminal result.
- **S4 — UI de análisis y chip.** Películas offers «Analizar biblioteca»
  with live progress («N/M · X skipeados» style) driven by the status
  endpoint. The per-file «Analizar» (delivered in movies-ffprobe T4) asks
  the cache first and renders instantly when fresh; only a miss runs
  ffprobe. After the job finishes (or during it, per progress updates) the
  visible chips refresh from persisted data without re-probing. All
  user-facing strings Spanish; render stays probe-free until the user acts.

## Tasks

- T1 — Backend persistencia: migration v12 `probe_results` in
  `backend/infrastructure/sqlite_history.py` (path PK, mtime, size,
  probe_json, height, analyzed_at; upsert + fetch + staleness helpers) and
  `POST /api/mixer/probe-file` persists on success. Tests: RED first.
  Route: backend.
- T2 — Backend cache leída: `POST /api/mixer/probe-cached` {paths} →
  {path: probe | null} serving only fresh rows (stale/missing → null).
  Tests: contract + staleness + non-array/invalid paths. Route: backend.
  Also REMOVES the pending-T2 `get_probe_result` entry added to
  `backend/vulture_whitelist.py` by T1 (its production caller is this route).
- T3 — Backend job de biblioteca: `POST /api/mixer/probe-library` (409 when
  a run is active) + `GET /api/mixer/probe-library/status`; single-flight
  job (state + `asyncio.create_task` per repo pattern), universe walk
  (movie folders + routing folders, video files only), skip-fresh /
  probe+persist with bounded ffprobe concurrency, per-file failures
  collected. Tests: single-flight 409, skip accounting, failure tolerance,
  status shape. Route: backend.
- T4 — Frontend chip: `probe-cached` fetch for the visible section files
  (zero probes on render), «Baja calidad» chip for fresh rows with
  height < 1080 in `PanelFiles` sections. Tests: chip present for analyzed
  low file, absent for un-analyzed, absent for analyzed ≥1080. Route: frontend.
- T5 — Frontend UI de análisis: «Analizar biblioteca» + progress display in
  Películas, cache-first per-file «Analizar», chip refresh after progress.
  Tests: RED→GREEN, gates. Route: frontend.
- T6 — Docs: ROADMAP.md task A marked as (partially/fully) delivered;
  feature doc log updates; slice disclosures.

## Log

- L1 — User request verbatim (2026-10-31):
  «-ya veo los cambios, esta implementado tambien el chip de cuando detectamos
  que es una pelicula de baja calidad? Esto deberiamos guardarlo tmb en base de
  datos.
  -y tambien deberiamos guardar en base de datos los datos de analisis de los
  archivos, más que nada para ahorrarnos ffprobe, (esto tambien deberia hacer
  que si los datos existen y hacemos el analisis masivo skipear los archivos
  que ya estan pasados).
  -tambien me gustaria investigar el tema de las colecciones de radarr y como
  poder enlazarlo con las colecciones de jellyfin?»
- L2 — Scope decisions same turn: user chose «Ahora: feature completa (ODD)»
  (chip + persistence + bulk, one feature) and, for the bulk scope, «Biblioteca
  completa (job+progreso)» — a server-side job over the whole library with a
  progress endpoint, not a per-movie button. First bullet answered: the chip
  is NOT implemented yet (sections come from filename tokens; probe data is
  not persisted anywhere — `own_grabs.quality` is Radarr's grab quality).
- L3 — Bullet 3 (Radarr↔Jellyfin collections) is a parallel RESEARCH unit,
  not part of this feature's code: inline research deliverable
  `RESEARCH-RADARR-JELLYFIN-COLLECTIONS.md` at repo root (writer gate: no
  feature doc exists for a research unit, so it runs in the parent session).
- L4 — Design pins: `probe-file` contract unchanged (always probes on
  request; the UI checks the cache BEFORE calling it); staleness = mtime +
  size match; chip threshold 1080 = roadmap default, config UI belongs to
  roadmap task B (upgrades list), NOT here; job universe = catalogue movie
  folders + `path_4k`/`path_3d` (the same sources the per-movie sections
  derive from: `wanted/all` + settings routing folders).
- L5 — T1 doc correction (2026-10-31, before first code write): the
  migration is **v12**, not v11 — `SCHEMA_VERSION = 11` is already the
  «indexadores-directos» registry (`indexers` table, v11). T1 ships
  `probe_results` with `SCHEMA_VERSION = 12`; new tables ride the SCHEMA
  script's `CREATE TABLE IF NOT EXISTS` (no `_apply_migrations` edit —
  that hook is for ALTERs on existing tables).
- L6 — Slice disclosure (harness ~400-line rule, recorded BEFORE T2's
  commit): after T1 the branch totals **495 authored lines / 3 commits**
  (`deeb224` T1 unit 203 L incl. its 127 L tests + `61d6d3b` feature doc +
  `e9e51bf` research doc) — past the ~400 slice. Delivery strategy for this
  feature = **single PR with disclosures** (same as movies-ffprobe L9);
  T6 updates this tally per task and the PR body carries the table.
- L7 — T4/T5 delivered; one T4-era rule SUPERSEDED by S4 (2026-10-31):
  `panelFilesProbe.test.tsx` pinned «a re-click re-probes and REPLACES the
  block — no caching»; S4 requires cache-first, so that test now pins «a
  re-click answers from the persisted probe — no second ffprobe run». The
  T4 comment «no cache» on `FilesSection` is gone with it. Logged here
  because a changed test must never look like a weakened one.
- L8 — T6 close (2026-10-31): ROADMAP task A marked delivered (bulk +
  persistence + chip); «Lista de upgrades» stays open and now says its
  prerequisite (probe persistence) already ships. Slice tally for the PR
  body: T1 `deeb224` (203 L incl. 127 L tests), docs `61d6d3b`/`e9e51bf`/
  `11f8b7f`, T2 `f44ae28` (152 L), T3 `4ea1bee` (370 L), T4 `32a7012`
  (~180 L), T5 `a900550` (~230 L) → whole branch ~1489 authored lines,
  delivered as ONE PR with this disclosure (same strategy as movies-ffprobe
  L9). Gates at close: backend 1810 passed, frontend 115 files / 900 tests,
  tsc/eslint/build 0, vulture 0.
- L9 — Subagent availability: `gentle-ai-worker` failed twice mid-task
  (T2 left only its RED tests; T3 wrote nothing). Both units were finished
  inline by the parent with RED/GREEN observed and full gates rerun; the
  unavailability is recorded here rather than retried into extra ceremony.
