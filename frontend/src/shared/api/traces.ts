import type { ActionResult, Trace } from '../types.ts'
import { apiFetch } from './auth.ts'

/**
 * Acknowledge one blocked-import incident — C-02's "limpiar" (one click).
 *
 * This rides the TRACE seam (`POST /api/trace/blocked/ack`), not
 * `/api/actions`: the action catalogue lives in the server config and the
 * dispatch in `copy_engine`, and an acknowledgement is neither an arr command
 * nor catalogue material — it is view state about a trace, recorded next to
 * the endpoint that draws the view. The payload is the same identity
 * `runAction` posts, so both seams agree on "which download".
 */
export async function ackBlockedImport(trace: Trace): Promise<ActionResult> {
  const res = await apiFetch('/api/trace/blocked/ack', {
    method: 'POST',
    body: JSON.stringify({
      source: trace.source,
      download_id: trace.download_id,
      ids: trace.ids,
    }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, error: msg }
  }
  return (await res.json()) as ActionResult
}
