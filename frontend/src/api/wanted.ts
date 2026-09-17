import type { ActionResult } from '../types'
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
