import type { ActionResult, ActionKey, Trace } from '../types'

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
    headers: { 'Content-Type': 'application/json' },
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
