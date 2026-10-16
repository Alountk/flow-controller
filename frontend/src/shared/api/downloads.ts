/** GET /api/downloads — the active arr queue snapshot (the one
 *  `downloads_cache._build_download` shapes). The dashboard card and the
 *  series tree's episode cross read it through the same `['downloads']` query
 *  key, so the SSE invalidation refreshes both at once. */

import { apiFetch } from './auth.ts'
import type { DownloadsResponse } from '../types.ts'

export async function fetchDownloads(): Promise<DownloadsResponse> {
  const res = await apiFetch('/api/downloads', {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as DownloadsResponse
}
