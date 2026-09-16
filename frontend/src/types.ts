export type ServiceKey = 'radarr' | 'sonarr' | 'amutorrent'

export type ServiceState = 'online' | 'offline' | 'unknown'

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
  if (state === 'online' || state === 'offline') {
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
