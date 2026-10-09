/** aMule's shared folders — read from and written to aMule's own files.
 *
 * These are deliberately NOT part of `settings.json`: aMule owns them, reads
 * them on reload, and would happily rewrite them from its own UI. Our settings
 * would be a second source of truth that silently diverges, which is the shape
 * of every path bug this app has already had.
 */

import { apiFetch } from './auth.ts'

export interface SharedDirs {
  /** Where aMule keeps the lists — shown so a misconfiguration is visible. */
  config_dir: string
  /** Roots aMule walks in full. */
  recursive: string[]
  /** Roots shared one level deep. */
  explicit: string[]
  /** The only folders this API will accept. */
  allowed_roots: string[]
}

export interface SharedDirsSaveResult {
  /** False when the files were written but aMule has not reloaded yet. */
  ok: boolean
  recursive: string[]
  explicit: string[]
  reload: { ok: boolean; detail: string }
}

export async function fetchSharedDirs(): Promise<SharedDirs> {
  const res = await apiFetch('/api/amule/shared-dirs', {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<SharedDirs>
}

/** Write both lists and ask aMule to reload. */
export async function saveSharedDirs(payload: {
  recursive: string[]
  explicit: string[]
}): Promise<SharedDirsSaveResult> {
  const res = await apiFetch('/api/amule/shared-dirs', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    // FastAPI's HTTPException carries the reason in `detail` — a 403 outside
    // allowed_roots means nothing to the user without it.
    const body = (await res.json().catch(() => null)) as { detail?: string } | null
    throw new Error(body?.detail ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<SharedDirsSaveResult>
}
