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

/* ---- Trazabilidad ---- */

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
  }
  intervals: {
    check: number
    max_retries: number
    retry_delay: number
    request_timeout: number
    import_timeout: number
  }
  tracing: { limit: number }
  server: { port: number }
}

export interface SaveSettingsResponse {
  ok: boolean
  restart_required: string[]
}

export interface PrototypeFile {
  name: string
  file: string
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
}

export interface AllMovie {
  id: number
  title: string
  year: number | null
  remotePoster: string
  has_file: boolean
  path_exists: boolean
  monitored: boolean
}

export interface AllSeries {
  id: number
  title: string
  year: number | null
  remotePoster: string
  has_file: boolean
  path_exists: boolean
  monitored: boolean
  episode_count: number
  episode_file_count: number
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
}

/** One episode of a series, as returned by /api/wanted/series/{id}/episodes.
 *  Used to resolve the `S##E##` in a file name to its title and air date. */
export interface SeriesEpisode {
  id: number | null
  season_number: number | null
  episode_number: number | null
  title: string
  air_date: string
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
  size: number
  modified: number
}

export interface BrowseResponse {
  ok: boolean
  items: FileItem[]
  path: string
  error?: string
}

export interface RootsResponse {
  roots: { path: string; name: string }[]
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
}

export interface CalendarResponse {
  items: CalendarItem[]
  start: string
  end: string
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
