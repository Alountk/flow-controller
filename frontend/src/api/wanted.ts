import type { ActionResult } from '../types'

const API_KEY = import.meta.env.VITE_API_KEY || ''

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (API_KEY) h['X-Api-Key'] = API_KEY
  return h
}

export async function searchWanted(source: string): Promise<ActionResult> {
  const res = await fetch('/api/wanted/search', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ source }),
  })
  return (await res.json()) as ActionResult
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
  return (await res.json()) as ActionResult
}
