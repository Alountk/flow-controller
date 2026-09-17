import type { ActionResult, ActionKey, Trace } from '../types'

const API_KEY = import.meta.env.VITE_API_KEY || ''

export interface ActionOptions {
  blocklist?: boolean
  delete_files?: boolean
  host?: string
  remote_path?: string
  local_path?: string
  output_path?: string
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (API_KEY) h['X-Api-Key'] = API_KEY
  return h
}

export async function runAction(
  action: ActionKey,
  trace: Trace,
  options: ActionOptions = {},
): Promise<ActionResult> {
  const res = await fetch(`/api/actions/${action}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      source: trace.source,
      download_id: trace.download_id,
      matched_hash: trace.matched_hash,
      ids: trace.ids,
      ...options,
    }),
  })
  return (await res.json()) as ActionResult
}
