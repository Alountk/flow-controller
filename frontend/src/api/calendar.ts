import { apiFetch, UnauthorizedError } from './auth'
import type { DestinationOptions } from '../types'

export interface Release {
  guid: string
  title: string
  size: number
  quality: string
  indexer: string
  indexerId: number
  indexerFlags: string
  seeders: number
  leechers: number
  protocol: string
  releaseGroup: string
  languages: string[]
}

export async function searchCalendarItem(
  source: string,
  type: string,
  id: number,
): Promise<{ ok: boolean; detail: string }> {
  const res = await apiFetch('/api/calendar/search', {
    method: 'POST',
    body: JSON.stringify({ source, type, id }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg }
  }
  return res.json() as Promise<{ ok: boolean; detail: string }>
}

export async function addCalendarItem(
  source: string,
  type: string,
  title: string,
  year?: number,
): Promise<{ ok: boolean; id?: number; detail: string }> {
  const res = await apiFetch('/api/calendar/add', {
    method: 'POST',
    body: JSON.stringify({ source, type, title, year }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg }
  }
  return res.json() as Promise<{ ok: boolean; id?: number; detail: string }>
}

export async function fetchCalendarReleases(
  source: string,
  type: string,
  id: number,
): Promise<{ releases: Release[]; detail: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 245000) // 245s timeout (backend is 240s)
  try {
    const res = await apiFetch('/api/calendar/releases', {
      method: 'POST',
      body: JSON.stringify({ source, type, id }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>
      const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
      return { releases: [], detail: msg }
    }
    return res.json() as Promise<{ releases: Release[]; detail: string }>
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { releases: [], detail: 'Timeout: Radarr/Sonarr no respondió en 65s. Verifica que el servicio esté activo y los indexadores respondan.' }
    }
    return { releases: [], detail: `Error de conexión: ${err}` }
  }
}

/**
 * Turn a thrown fetch into something the user can act on.
 *
 * `TypeError: Failed to fetch` is what the browser reports for offline, DNS and
 * CORS problems alike — repeating it verbatim tells the user nothing.
 */
function describeFetchFailure(err: unknown): string {
  if (err instanceof UnauthorizedError) {
    // apiFetch already triggered the key prompt; say what happened rather than
    // leaking the exception name.
    return 'API key rechazada. Vuelve a introducirla para continuar.'
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return 'La petición tardó demasiado y se canceló'
  }
  const name = err instanceof Error ? err.name : ''
  if (name === 'TypeError') {
    return 'No se pudo contactar con el servidor. Comprueba la conexión y que el backend siga activo'
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/**
 * The folders the user may choose as a grab destination.
 *
 * Never rejects: the combo has a built-in library default, so a failure here
 * must leave the modal usable rather than block searching or grabbing. A
 * failed load resolves to an empty list (plus the reason in `detail`).
 */
export async function fetchCalendarDestinations(source: string): Promise<DestinationOptions> {
  try {
    const res = await apiFetch(
      `/api/calendar/destinations?source=${encodeURIComponent(source)}`,
      {},
    )
    if (!res.ok) {
      return { folders: [], arr_available: false, detail: `HTTP ${res.status}` }
    }
    const body = await res.json() as Partial<DestinationOptions>
    return {
      folders: Array.isArray(body.folders) ? body.folders : [],
      arr_available: body.arr_available === true,
      detail: typeof body.detail === 'string' ? body.detail : '',
    }
  } catch (err) {
    return { folders: [], arr_available: false, detail: describeFetchFailure(err) }
  }
}

export async function grabCalendarRelease(
  source: string,
  guid: string,
  indexerId: number = 0,
  movieId: number = 0,
  episodeId: number = 0,
  destination?: string,
): Promise<{ ok: boolean; detail: string }> {
  // A rejected fetch (offline, aborted, DNS) must surface as a failed result,
  // not as an unhandled rejection that leaves the modal stuck on "Descargando".
  // `destination` is only added when set, so a library grab (the default) sends
  // the same body as before this option existed.
  const body: Record<string, unknown> = { source, guid, indexerId, movieId, episodeId }
  if (destination) body.destination = destination
  let res: Response
  try {
    res = await apiFetch('/api/calendar/grab', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { ok: false, detail: describeFetchFailure(err) }
  }
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof errorBody.detail === 'string' ? errorBody.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg }
  }
  return res.json() as Promise<{ ok: boolean; detail: string }>
}

export async function grabCalendarReleaseBatch(
  source: string,
  guids: string[],
  indexerIds: number[] = [],
  movieId: number = 0,
  episodeId: number = 0,
  destination?: string,
): Promise<{ ok: boolean; detail: string; downloaded: string[]; errors: { guid: string; detail: string }[] }> {
  const body: Record<string, unknown> = { source, guids, indexerIds, movieId, episodeId }
  if (destination) body.destination = destination
  let res: Response
  try {
    res = await apiFetch('/api/calendar/grab-batch', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { ok: false, detail: describeFetchFailure(err), downloaded: [], errors: [] }
  }
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof errorBody.detail === 'string' ? errorBody.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg, downloaded: [], errors: [] }
  }
  return res.json() as Promise<{ ok: boolean; detail: string; downloaded: string[]; errors: { guid: string; detail: string }[] }>
}
