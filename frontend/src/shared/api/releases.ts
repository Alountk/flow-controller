import { apiFetch } from './auth.ts'

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
