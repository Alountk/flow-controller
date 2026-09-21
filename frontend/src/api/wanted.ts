import type { ActionResult, ScanResult, PaginatedResponse, WantedMovie, WantedEpisode, AllMovie, AllSeries } from '../types'
import { authHeaders } from './auth'

/** Only include the filter when it has content, so an empty box is a no-op. */
function queryParam(query: string): string {
  const trimmed = query.trim()
  return trimmed ? `&q=${encodeURIComponent(trimmed)}` : ''
}

async function handleResponse(res: Response): Promise<ActionResult> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, error: msg }
  }
  return (await res.json()) as ActionResult
}

export async function fetchWantedMovies(page = 1, pageSize = 50, query = ''): Promise<PaginatedResponse<WantedMovie>> {
  const res = await fetch(`/api/wanted?source=radarr&page=${page}&page_size=${pageSize}${queryParam(query)}`, { headers: authHeaders() })
  const data = await res.json()
  const radarr = data?.wanted?.radarr
  return {
    items: (radarr?.items ?? []) as WantedMovie[],
    total: radarr?.total ?? 0,
    page,
    page_size: pageSize,
    // Carry the failure through: without it a timeout renders as "no missing".
    error: radarr?.error,
    error_kind: radarr?.error_kind,
  }
}

export async function fetchWantedEpisodes(page = 1, pageSize = 50, query = ''): Promise<PaginatedResponse<WantedEpisode>> {
  const res = await fetch(`/api/wanted?source=sonarr&page=${page}&page_size=${pageSize}${queryParam(query)}`, { headers: authHeaders() })
  const data = await res.json()
  const sonarr = data?.wanted?.sonarr
  return {
    items: (sonarr?.items ?? []) as WantedEpisode[],
    total: sonarr?.total ?? 0,
    page,
    page_size: pageSize,
    error: sonarr?.error,
    error_kind: sonarr?.error_kind,
  }
}

export async function fetchAllMovies(page = 1, pageSize = 50, query = ''): Promise<PaginatedResponse<AllMovie>> {
  const res = await fetch(`/api/wanted/all?page=${page}&page_size=${pageSize}${queryParam(query)}`, { headers: authHeaders() })
  return (await res.json()) as PaginatedResponse<AllMovie>
}

export async function fetchAllSeries(page = 1, pageSize = 50, query = ''): Promise<PaginatedResponse<AllSeries>> {
  const res = await fetch(`/api/wanted/series/all?page=${page}&page_size=${pageSize}${queryParam(query)}`, { headers: authHeaders() })
  return (await res.json()) as PaginatedResponse<AllSeries>
}

export async function searchWanted(source: string): Promise<ActionResult> {
  const res = await fetch('/api/wanted/search', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ source }),
  })
  return handleResponse(res)
}

export async function searchWantedItem(
  source: string,
  ids: Record<string, number | null>,
): Promise<ActionResult> {
  const res = await fetch('/api/wanted/search/item', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ source, ids }),
  })
  return handleResponse(res)
}

export async function scanForMovies(
  source: string,
  folderPath: string,
  movieId?: number,
  seriesId?: number,
  customTitle?: string,
): Promise<ScanResult> {
  const body: Record<string, unknown> = {
    source,
    remote_path: folderPath,
  }
  if (movieId || seriesId || customTitle) {
    body.ids = {
      ...(movieId ? { movie_id: movieId } : {}),
      ...(seriesId ? { series_id: seriesId } : {}),
      ...(customTitle ? { custom_title: customTitle } : {}),
    }
  }

  const res = await fetch('/api/wanted/scan', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const resp = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof resp.detail === 'string' ? resp.detail : null) || `HTTP ${res.status}`
    return { ok: false, matches: [], scanned_files: 0, detail: msg }
  }
  return (await res.json()) as ScanResult
}
