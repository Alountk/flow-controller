export type ServiceKey = 'radarr' | 'sonarr' | 'amutorrent'

export type ServiceState =
  | 'online'
  | 'offline'
  /** Reachable, but the API key was rejected. A different fix from "offline". */
  | 'misconfigured'
  | 'unknown'

export interface TorrentStats {
  total: number
  downloading: number
  completed: number
  errors: number
}

export interface AmutorrentMeta {
  version?: string
  torrents?: TorrentStats
}

export interface ServiceStatus {
  key: ServiceKey
  label: string
  state: ServiceState
  reason: string
  meta?: AmutorrentMeta
}

export interface StatusResponse {
  radarr: string
  sonarr: string
  amutorrent: string
  flow: string
  updated_at: number
  checking: boolean
  amutorrent_meta?: AmutorrentMeta
  [key: string]: unknown
}

export function parseStatus(raw: unknown): { state: ServiceState; reason: string } {
  if (typeof raw !== 'string' || !raw) return { state: 'unknown', reason: 'Sin datos' }
  const [state, ...rest] = raw.split(':')
  const reason = rest.join(':').trim() || raw
  if (state === 'online' || state === 'offline' || state === 'misconfigured') {
    return { state, reason }
  }
  return { state: 'unknown', reason: raw }
}

/* ---- Trazas · el dato de Seguimiento (antes: Trazabilidad) ---- */

export type TraceStage =
  | 'downloading'
  | 'downloaded'
  | 'import_blocked'
  | 'importing'
  | 'sent'
  | 'failed'

export interface TraceTorrent {
  state: string | null
  progress: number
  category: string | null
  save_path: string | null
  current_path: string | null
  content_path: string | null
  size: number | null
}

export interface TraceQueue {
  state: string | null
  status: string | null
  output_path: string | null
  messages: string[]
}

export interface TraceIds {
  queue_id: number | null
  episode_id: number | null
  movie_id: number | null
  series_id: number | null
}

export interface Trace {
  source: ServiceKey
  title: string
  date: string | null
  indexer: string | null
  download_client: string | null
  download_client_host: string | null
  download_id: string
  matched_hash: string | null
  stage: TraceStage
  torrent: TraceTorrent | null
  expected_category: string | null
  category_ok: boolean | null
  paused: boolean
  ids: TraceIds
  destination: string | null
  queue: TraceQueue | null
}

/* ---- Acciones ---- */

export type ActionKey =
  | 'fix_category'
  | 'retry_import'
  | 'research'
  | 'pause'
  | 'resume'
  | 'cancel_download'
  | 'remove_queue'
  | 'delete_torrent'
  | 'fix_path_mapping'
  | 'copy_files'

export interface ActionMeta {
  key: ActionKey
  label: string
  description: string
  destructive: boolean
  scope: string
}

export interface ActionsResponse {
  actions: ActionMeta[]
  safe_mode: boolean
  available: ActionKey[]
}

export interface ActionStep {
  target: string
  ok: boolean
  detail: string
}

export interface ActionResult {
  action?: ActionKey
  label?: string
  destructive?: boolean
  ok: boolean
  steps?: ActionStep[]
  error?: string
  safe_mode?: boolean
}

export interface TraceSummary {
  downloading: number
  downloaded: number
  import_blocked: number
  failed: number
  sent: number
  category_mismatches: number
}

export interface TraceResponse {
  traces: Trace[]
  summary: TraceSummary
  indexer: string
  updated_at: number
}

export const STAGE_LABELS: Record<TraceStage, string> = {
  downloading: 'Descargando',
  downloaded: 'Descargada',
  import_blocked: 'Import bloqueado',
  importing: 'Importando',
  sent: 'Enviada',
  failed: 'Fallida',
}

/* ---- Auto-copy sweep ---- */

/** Per-trace verdict of the auto-copy policy (`auto_copy.py`). `copy` means the
 *  policy wants the download in the library; whether it acted depends on
 *  `safe_mode` and is read from the entry's `action`. */
export type AutoCopyDecision = 'copy' | 'wait' | 'skip'

/** What the driver did for an entry. `null` when it only decided (wait/skip). */
export type AutoCopyAction = 'copied' | 'proposed' | 'failed'

/** Mirrors `_zero_counts()` in `backend/auto_copy_driver.py`. `copy` counts the
 *  traces the policy wanted to copy; `copied`/`proposed`/`failed` break that
 *  set into what actually happened. */
export interface AutoCopySweepCounts {
  traces: number
  copy: number
  copied: number
  proposed: number
  wait: number
  skip: number
  failed: number
}

/** Mirrors `_entry()` in `backend/auto_copy_driver.py`. `reason` is user-facing
 *  Spanish text written to be read by a human. */
export interface AutoCopySweepEntry {
  key: string
  source: string
  title: string
  decision: AutoCopyDecision
  reason: string
  action: AutoCopyAction | null
  detail: string | null
}

/** Mirrors `_summary()` in `backend/auto_copy_driver.py`. `started_at` and
 *  `finished_at` are absent in the route's last-resort error body, and
 *  `counts` may be `{}` there, so callers must read counts defensively. */
export interface AutoCopySweepResult {
  ok: boolean
  running: boolean
  safe_mode: boolean | null
  detail: string
  counts: AutoCopySweepCounts
  entries: AutoCopySweepEntry[]
  errors: string[]
  started_at?: number | null
  finished_at?: number | null
}

/* ---- Auto-copy decision history ---- */

/** The sweep's OUTCOME for one candidate, as stored in `auto_copy_log`. The
 *  action when there is one (`copied`/`proposed`/`failed`) and the policy's
 *  decision otherwise (`wait`/`skip`). One field, so the UI needs no second
 *  lookup. */
export type AutoCopyLogDecision = 'copied' | 'proposed' | 'wait' | 'skip' | 'failed'

/** Mirrors one `auto_copy_log` row. It exists only when the outcome CHANGED, so
 *  the list reads as a timeline of transitions, not a sweep-by-sweep dump.
 *  `reason` is the same user-facing Spanish text the sweep panel shows. */
export interface AutoCopyLogEntry {
  id: number
  key: string
  source: string | null
  title: string | null
  decision: AutoCopyLogDecision
  reason: string | null
  at: number
}

/** Mirrors GET /api/auto-copy/history. `error` is present when the store could
 *  not be read, so the panel can tell "nothing happened" from "unreadable". */
export interface AutoCopyHistoryResponse {
  items: AutoCopyLogEntry[]
  error?: string
}


/* ---- Config / Developer ---- */

export interface ConfigResponse {
  developer: boolean
  /** Whether the backend requires an API key. The key itself is never sent. */
  auth_required: boolean
  /** False when the stored service credentials could not be decrypted. */
  encryption_ok?: boolean
  /** Why they could not be decrypted, ready to show. */
  encryption_error?: string
}

export interface Settings {
  services: {
    radarr: { url: string; api_key: string }
    sonarr: { url: string; api_key: string }
    amutorrent: { url: string; api_key: string; user: string; password: string }
  }
  security: { api_key: string; safe_mode: boolean }
  developer: boolean
  paths: {
    download_amule: string
    download_torrent: string
    allowed_roots: string[]
    // Folders a release is routed to when nobody picked one by hand.
    // Optional because a settings file written before this feature simply
    // does not have the keys — absent and "" mean the same thing: no routing.
    path_4k?: string
    path_3d?: string
  }
  intervals: {
    check: number
    max_retries: number
    retry_delay: number
    request_timeout: number
    import_timeout: number
  }
  tracing: { limit: number }
  /** Mirrors `DEFAULTS["retention"]` in backend/settings.py. Read live through
   *  `config.rebuild()`, so a change needs no restart. */
  retention: { amule_days: number }
  server: { port: number }
}

export interface SaveSettingsResponse {
  ok: boolean
  restart_required: string[]
}

/** Whether a design made the cut, and why or why not. */
export type PrototypeStatus = 'selected' | 'discarded' | 'candidate' | 'unlisted'

export interface PrototypeFile {
  name: string
  file: string
  /** Grouping key: `setup`, `landing`, `peliculas`, `series`, `otros`. */
  section: string
  status: PrototypeStatus
  /** True only where the manifest says so — never inferred from status. */
  recommend: boolean
  /** For a discarded design, WHY it was discarded. Empty otherwise. */
  note: string
}

/* ---- Wanted / Missing Content ---- */

export interface WantedMovie {
  id: number
  title: string
  year: number | null
  overview: string
  remotePoster: string
  has_file: boolean
  altTitles: string[]
  /** Unix seconds when this app asked to download the title, or null when it
   *  never did (or the grab is older than the backend's lookback window). */
  grabbed_at?: number | null
  /** Folder the grab was sent to, or null when it went to the arr's library. */
  grabbed_destination?: string | null
}

export interface AllMovie {
  id: number
  title: string
  year: number | null
  remotePoster: string
  has_file: boolean
  /** The movie's folder as Radarr knows it. The Calidad view reads the
   *  path_4k/path_3d membership off it; "" means Radarr sent no path. */
  path: string
  /** Quality of the file Radarr owns (`movieFile.quality.quality.name`, e.g.
   *  "Bluray-2160p"), or "" when unknown — no file, or an odd payload shape.
   *  "" must read as unknown on screen, never as a guessed class. */
  quality: string
  /** The file Radarr owns, by its own `movieFile.relativePath`. Optional: a
   *  settings/response written before this field existed has none, and "" (or
   *  a missing key) means "no name available here" — never a title-derived
   *  name the app would pass off as the file on disk. */
  file_name?: string
  /** Languages OF THAT FILE (`movieFile.languages` → names), or [] when the
   *  payload carries none. An empty list renders nothing; it is never [""] and
   *  an entry Radarr sent without a `name` never becomes "undefined". */
  languages?: string[]
  path_exists: boolean
  monitored: boolean
  /** Radarr has NOT imported a file for this title, but its folder holds a
   *  video — read off disk by the backend, only when `has_file` is false.
   *  True is direct evidence of bytes on disk; false means "checked, no
   *  video found", "folder unreadable/missing", or "already imported" (the
   *  backend never lists an imported title's folder). Optional because a
   *  response written before this field existed has none. */
  has_unimported_file?: boolean
  /** Unix seconds when this app asked to download the title, or null when it
   *  never did (or the grab is older than the backend's lookback window). */
  grabbed_at?: number | null
  /** Folder the grab was sent to, or null when it went to the arr's library. */
  grabbed_destination?: string | null
}

export interface AllSeries {
  id: number
  title: string
  year: number | null
  remotePoster: string
  has_file: boolean
  /** The series' folder as Sonarr knows it. Sonarr's list carries no quality,
   *  so the Calidad view derives the class of a series from this path alone
   *  (path_4k → 4K, path_3d → 3D, anything else → en biblioteca). */
  path: string
  path_exists: boolean
  monitored: boolean
  episode_count: number
  episode_file_count: number
  /** Unix seconds when this app asked to download ANY of the series' episodes,
   *  or null when it never did (or the grab is outside the lookback window). */
  grabbed_at?: number | null
  /** Folder the newest episode grab was sent to, or null for the arr's library. */
  grabbed_destination?: string | null
}

export interface WantedEpisode {
  id: number
  title: string
  series_title: string
  series_id: number | null
  season_number: number | null
  episode_number: number | null
  air_date: string
  overview: string
  has_file: boolean
  /** Unix seconds when this app asked to download the episode, or null when it
   *  never did (or the grab is older than the backend's lookback window). */
  grabbed_at?: number | null
  /** Folder the grab was sent to, or null when it went to the arr's library. */
  grabbed_destination?: string | null
}

/** One episode of a series, as returned by /api/wanted/series/{id}/episodes.
 *  Used to resolve the `S##E##` in a file name to its title and air date, and
 *  listed by the detail panel's Episodios tab. */
export interface SeriesEpisode {
  id: number | null
  season_number: number | null
  episode_number: number | null
  title: string
  air_date: string
  has_file: boolean
  /** Quality of the episode's file, or null when it could not be read — a
   *  null beside `has_file: true` means the file IS there and we could not
   *  inspect it, never that there is no file. */
  quality: string | null
  /** Folder holding the episode's file, under the same null contract. */
  path: string | null
}

export interface WantedService {
  items: (WantedMovie | WantedEpisode)[]
  total: number
  page?: number
  page_size?: number
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page?: number
  page_size?: number
  /** Present when the backend could not reach Radarr/Sonarr. An empty list
   *  means "nothing missing" only when this is absent. */
  error?: string
  error_kind?: string
}

export interface WantedResponse {
  wanted: {
    radarr?: WantedService
    sonarr?: WantedService
  }
  updated_at: number
}

/* ---- Scan for misplaced files ---- */

export interface ScanMatch {
  file_path: string
  file_name: string
  movie_id: number
  movie_title: string
  movie_year: number | null
  target_path: string
  score: number
  matched_title: string
}

export interface ScanResult {
  ok: boolean
  matches: ScanMatch[]
  scanned_files: number
  total_wanted?: number
  detail?: string
}

/* ---- File Manager ---- */

export interface FileItem {
  name: string
  path: string
  is_dir: boolean
  /** The backend's classification of a FILE as video
   *  (`_file_entry.is_video`, from `naming.MEDIA_EXTENSIONS`). Absent on a
   *  payload that was never classified (an older build, a test stub): absent
   *  is UNKNOWN — never read as "not a video". */
  is_video?: boolean
  size: number
  modified: number
}

export interface BrowseResponse {
  ok: boolean
  items: FileItem[]
  path: string
  error?: string
}

/** F-07 — where a file came from: the arr's import queue, the arr's history,
 *  or a grab this app made itself (`own_grabs`). `null` means no source
 *  claims the file — the UI shows no chip rather than guessing. */
export type FileProvenance = 'own' | 'queue' | 'history'

/** One file in GET /api/files/retention's `files` (backend `file_retention`).
 *  Marking only — the endpoint never deletes. `age_days: null` means the clock
 *  store could not be read: an UNKNOWN age, never a zero one, so the UI shows
 *  nothing rather than a number nobody measured.
 *
 *  `provenance`/`provenance_label` (F-07) follow the same honesty: the key is
 *  the machine value, the label the Spanish text the backend chose, and both
 *  are null together when nothing attributes the file. */
export interface RetentionFile {
  name: string
  first_seen_at: number | null
  age_days: number | null
  expired: boolean
  provenance: FileProvenance | null
  provenance_label: string | null
}

export interface RetentionResponse {
  ok: boolean
  /** The resolved directory the rows belong to — the same resolution
   *  `/browse` uses, so `path + '/' + name` is the browse `item.path`. */
  path: string
  days: number
  files: RetentionFile[]
}

export interface RootsResponse {
  roots: {
    path: string
    name: string
    /** Where the root sits: the mounts the panes navigate, an arr's library,
     *  or a quality folder. Absent on an older backend — consumers must treat
     *  its absence as plain navigation. */
    role?: 'navigation' | 'library' | '4k' | '3d'
    /** The words the picker shows when they say more than the name. */
    label?: string
    /** Which arr owns this library root (`radarr` / `sonarr`). */
    service?: string
  }[]
  /** Non-empty when a configured arr reported no root folders: the Spanish
   *  reason the libraries are missing, never a silent short list. */
  detail?: string
}

export interface CalendarItem {
  type: 'movie' | 'episode'
  id: number
  title: string
  date: string
  year: number | null
  has_file: boolean
  remotePoster: string
  series_title: string | null
  season_number: number | null
  episode_number: number | null
  source: string
  /** Unix seconds when this app asked to download this movie or episode, or
   *  null when it never did (or the grab is outside the lookback window). */
  grabbed_at?: number | null
  /** Folder the grab was sent to, or null when it went to the arr's library. */
  grabbed_destination?: string | null
}

export interface CalendarResponse {
  items: CalendarItem[]
  start: string
  end: string
}

/** Mirrors GET /api/calendar/destinations. `folders` is the ordered, deduped
 *  list the release-search combo offers (arr roots first). `arr_available` is
 *  false when the arr's root folders could not be read, so only the app's
 *  allowed roots are present; `detail` is the Spanish reason for that
 *  degradation, empty when nothing degraded. */
export interface DestinationOptions {
  folders: string[]
  arr_available: boolean
  detail: string
}

export interface DiskVolume {
  name: string
  path: string
  total_bytes: number
  used_bytes: number
  free_bytes: number
  percent: number
  error?: string
}

export interface DiskResponse {
  volumes: DiskVolume[]
}
