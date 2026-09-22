import type { AutoCopySweepCounts, AutoCopySweepResult } from '../types'
import { apiFetch, UnauthorizedError } from './auth'

function emptyCounts(): AutoCopySweepCounts {
  return { traces: 0, copy: 0, copied: 0, proposed: 0, wait: 0, skip: 0, failed: 0 }
}

/**
 * Turn any failure into the summary shape the panel already knows how to show.
 *
 * The endpoint is built never to 500, so a rejected fetch (offline, aborted,
 * DNS) or an unreadable body is the only way this call fails. It must come back
 * as a result, not as an unhandled rejection: a stuck spinner was a real bug
 * here, and the fix is the same pattern `grabCalendarRelease` uses.
 */
function failedResult(detail: string): AutoCopySweepResult {
  return {
    ok: false,
    running: false,
    safe_mode: null,
    detail,
    counts: emptyCounts(),
    entries: [],
    errors: [detail],
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
 * Run ONE auto-copy sweep.
 *
 * An explicit POST on purpose: the sweep can write to the media library, so it
 * must never be a side effect of reading the polled trace. Never rejects — a
 * failed request resolves to a failed summary.
 */
export async function runAutoCopySweep(): Promise<AutoCopySweepResult> {
  let res: Response
  try {
    res = await apiFetch('/api/auto-copy/sweep', { method: 'POST' })
  } catch (err) {
    return failedResult(describeFetchFailure(err))
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return failedResult(msg)
  }
  try {
    return (await res.json()) as AutoCopySweepResult
  } catch (err) {
    return failedResult(describeFetchFailure(err))
  }
}
