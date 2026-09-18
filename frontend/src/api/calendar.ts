import { authHeaders } from './auth'

export interface Release {
  guid: string
  title: string
  size: number
  quality: string
  indexer: string
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
  const res = await fetch('/api/calendar/search', {
    method: 'POST',
    headers: authHeaders(),
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
  const res = await fetch('/api/calendar/add', {
    method: 'POST',
    headers: authHeaders(),
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
  const res = await fetch('/api/calendar/releases', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ source, type, id }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { releases: [], detail: msg }
  }
  return res.json() as Promise<{ releases: Release[]; detail: string }>
}

export async function grabCalendarRelease(
  source: string,
  guid: string,
): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('/api/calendar/grab', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ source, guid }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg }
  }
  return res.json() as Promise<{ ok: boolean; detail: string }>
}
