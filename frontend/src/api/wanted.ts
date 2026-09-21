import type { ActionResult, ScanResult, PaginatedResponse, WantedMovie, WantedEpisode, AllMovie, AllSeries, SeriesEpisode } from '../types'
import { apiFetch } from './auth'

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
  const res = await apiFetch(`/api/wanted?source=radarr&page=${page}&page_size=${pageSize}${queryParam(query)}`, {})
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
  const res = await apiFetch(`/api/wanted?source=sonarr&page=${page}&page_size=${pageSize}${queryParam(query)}`, {})
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
  const res = await apiFetch(`/api/wanted/all?page=${page}&page_size=${pageSize}${queryParam(query)}`, {})
  return (await res.json()) as PaginatedResponse<AllMovie>
}

export async function fetchAllSeries(page = 1, pageSize = 50, query = ''): Promise<PaginatedResponse<AllSeries>> {
  const res = await apiFetch(`/api/wanted/series/all?page=${page}&page_size=${pageSize}${queryParam(query)}`, {})
  return (await res.json()) as PaginatedResponse<AllSeries>
}

/** Every episode of a series, for enriching the "En carpeta" navigator.
 *
 *  One call per series, not per file: the browser resolves each file's `S##E##`
 *  against this map locally. A failure carries `error` so the UI degrades to no
 *  annotation instead of a wrong one.
 */
export async function fetchSeriesEpisodes(seriesId: number): Promise<{ episodes: SeriesEpisode[]; error?: string }> {
  const res = await apiFetch(`/api/wanted/series/${seriesId}/episodes`, {})
  const data = await res.json()
  return {
    episodes: (data?.episodes ?? []) as SeriesEpisode[],
    error: data?.error,
  }
}

export async function searchWanted(source: string): Promise<ActionResult> {
  const res = await apiFetch('/api/wanted/search', {
    method: 'POST',
    body: JSON.stringify({ source }),
  })
  return handleResponse(res)
}

export async function searchWantedItem(
  source: string,
  ids: Record<string, number | null>,
): Promise<ActionResult> {
  const res = await apiFetch('/api/wanted/search/item', {
    method: 'POST',
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

  const res = await apiFetch('/api/wanted/scan', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const resp = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof resp.detail === 'string' ? resp.detail : null) || `HTTP ${res.status}`
    return { ok: false, matches: [], scanned_files: 0, detail: msg }
  }
  return (await res.json()) as ScanResult
}
