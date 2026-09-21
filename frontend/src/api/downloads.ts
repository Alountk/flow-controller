import { apiFetch } from './auth'

/** An active download, joined from Radarr/Sonarr and the download client. */
export interface Download {
  id: string
  source: string
  title: string
  status: string
  tracked_state: string
  tracked_status: string
  /** The import did not complete, or the arr reported a warning. */
  problem: boolean
  messages: string[]
  progress: number
  size: number
  sizeleft: number
  timeleft: string
  download_client: string
  indexer: string
  /** Whether the download client entry was found. Speed/ETA exist only then. */
  matched: boolean
  speed: number | null
  eta_seconds: number | null
  seeders: number | null
  leechers: number | null
  torrent_state: string | null
}

export interface DownloadsFailure {
  source: string
  error: string
  error_kind?: string
}

export interface DownloadsResponse {
  downloads: Download[]
  /** Per-source failures. An empty list is only trustworthy when this is empty. */
  errors: DownloadsFailure[]
  updated_at: number
}

export async function fetchDownloads(): Promise<DownloadsResponse> {
  const res = await apiFetch('/api/downloads', {})
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return (await res.json()) as DownloadsResponse
}
