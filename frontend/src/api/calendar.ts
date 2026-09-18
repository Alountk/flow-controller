import { authHeaders } from './auth'

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
