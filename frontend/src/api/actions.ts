import type { ActionResult, ActionKey, Trace } from '../types'
import { authHeaders } from './auth'

export interface ActionOptions {
  blocklist?: boolean
  delete_files?: boolean
  host?: string
  remote_path?: string
  local_path?: string
  output_path?: string
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
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, error: msg }
  }
  return (await res.json()) as ActionResult
}
