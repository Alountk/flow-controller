import type { BrowseResponse, RetentionResponse, RootsResponse } from '../types.ts'
import { apiFetch } from './auth.ts'

async function handleResponse(res: Response): Promise<{ ok: boolean; detail: string }> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg }
  }
  return (await res.json()) as { ok: boolean; detail: string }
}

export interface QueueOp {
  id: string
  type: string
  name: string
  src: string
  dst: string
  status: string
  detail: string | null
  progress: number
  copied_bytes: number
  total_bytes: number
  files_done: number
  files_total: number
  import_status: string
}

export interface QueueStatusResponse {
  queue: QueueOp[]
  completed: QueueOp[]
  running: boolean
}

export interface RenameSidecar {
  from: string
  to: string
}

/** What `GET /api/files/rename-preview` offers for one 4K/3D copy. */
export interface RenameProposal {
  ok: boolean
  detail: string
  src?: string
  loose?: boolean
  /** The template proved it can write this movie's name; without it there is no plan. */
  named?: boolean
  folder?: string
  name?: string
  extension?: string
  sidecars?: RenameSidecar[]
  warnings?: string[]
  movie?: { id?: number; title?: string; year?: number | null } | null
}

export interface RenameResult {
  ok: boolean
  detail: string
  moved?: { from: string; to: string }[]
  failed?: { name: string; detail: string }[]
}

export interface RenameCandidate extends RenameProposal {
  src: string
}

export interface RenameCandidatesResponse {
  ok: boolean
  items: RenameCandidate[]
  scanned: number
  detail: string
}

export async function renameCandidates(): Promise<RenameCandidatesResponse> {
  const res = await apiFetch('/api/files/rename-candidates', {})
  return (await res.json()) as RenameCandidatesResponse
}

export async function renamePreview(path: string): Promise<RenameProposal> {
  const res = await apiFetch(`/api/files/rename-preview?remote_path=${encodeURIComponent(path)}`, {})
  return (await res.json()) as RenameProposal
}

export async function renameApply(body: {
  remote_path: string
  folder: string
  name: string
}): Promise<RenameResult> {
  const res = await apiFetch('/api/files/rename-apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as RenameResult
}

export async function fetchRoots(): Promise<RootsResponse> {
  const res = await apiFetch('/api/files/roots', {})
  return (await res.json()) as RootsResponse
}

export async function browsePath(path: string): Promise<BrowseResponse> {
  const res = await apiFetch(`/api/files/browse?path=${encodeURIComponent(path)}`, {})
  return (await res.json()) as BrowseResponse
}

export async function fetchRetention(path: string): Promise<RetentionResponse> {
  const res = await apiFetch(`/api/files/retention?path=${encodeURIComponent(path)}`, {})
  return (await res.json()) as RetentionResponse
}

export async function createDirectory(path: string): Promise<{ ok: boolean; detail: string }> {
  const res = await apiFetch('/api/files/mkdir', {
    method: 'POST',
    body: JSON.stringify({ remote_path: path }),
  })
  return handleResponse(res)
}

export async function renameItem(oldPath: string, newPath: string): Promise<{ ok: boolean; detail: string }> {
  const res = await apiFetch('/api/files/rename', {
    method: 'POST',
    body: JSON.stringify({ remote_path: oldPath, local_path: newPath }),
  })
  return handleResponse(res)
}

export async function deleteItem(path: string): Promise<{ ok: boolean; detail: string }> {
  const res = await apiFetch('/api/files/delete', {
    method: 'POST',
    body: JSON.stringify({ remote_path: path }),
  })
  return handleResponse(res)
}

export async function copyItem(src: string, dst: string): Promise<{ ok: boolean; detail: string }> {
  const res = await apiFetch('/api/files/copy', {
    method: 'POST',
    body: JSON.stringify({ remote_path: src, local_path: dst }),
  })
  return handleResponse(res)
}

export async function queueAdd(
  type: 'copy' | 'move',
  src: string,
  dst: string,
  arrSource?: string,
  movieId?: number,
  seriesId?: number,
): Promise<{ ok: boolean; detail: string; op?: QueueOp }> {
  const body: Record<string, unknown> = { source: type, remote_path: src, local_path: dst }
  if (arrSource) {
    body.host = arrSource
    const ids: Record<string, number> = {}
    if (movieId) ids.movie_id = movieId
    if (seriesId) ids.series_id = seriesId
    body.ids = ids
  }
  const res = await apiFetch('/api/files/queue/add', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return handleResponse(res) as Promise<{ ok: boolean; detail: string; op?: QueueOp }>
}

export async function queueStatus(): Promise<QueueStatusResponse> {
  const res = await apiFetch('/api/files/queue/status', {})
  return (await res.json()) as QueueStatusResponse
}

export async function queueCancel(opId: string): Promise<{ ok: boolean; detail: string }> {
  const res = await apiFetch(`/api/files/queue/cancel/${opId}`, {
    method: 'POST',
  })
  return handleResponse(res)
}

/** T1/S3 — manual override for an op that finished behind the scenes but
 * still shows as pending/running (dead consumer, stale history row). */
export async function completeQueueOp(opId: string): Promise<{ ok: boolean; detail: string }> {
  const res = await apiFetch(`/api/files/queue/complete/${opId}`, {
    method: 'POST',
  })
  return handleResponse(res)
}
