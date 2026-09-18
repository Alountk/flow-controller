import type { ActionResult, ScanResult } from '../types'
import { authHeaders } from './auth'

async function handleResponse(res: Response): Promise<ActionResult> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, error: msg }
  }
  return (await res.json()) as ActionResult
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
  languages: string[],
  movieId?: number,
  seriesId?: number,
  customTitle?: string,
): Promise<ScanResult> {
  const body: Record<string, unknown> = {
    source,
    remote_path: folderPath,
    local_path: languages.join(','),
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
