import type { BrowseResponse, RootsResponse } from '../types'
import { authHeaders } from './auth'

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
}

export interface QueueStatusResponse {
  queue: QueueOp[]
  completed: QueueOp[]
  running: boolean
}

export async function fetchRoots(): Promise<RootsResponse> {
  const res = await fetch('/api/files/roots')
  return (await res.json()) as RootsResponse
}

export async function browsePath(path: string): Promise<BrowseResponse> {
  const res = await fetch(`/api/files/browse?path=${encodeURIComponent(path)}`)
  return (await res.json()) as BrowseResponse
}

export async function createDirectory(path: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('/api/files/mkdir', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ remote_path: path }),
  })
  return handleResponse(res)
}

export async function renameItem(oldPath: string, newPath: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('/api/files/rename', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ remote_path: oldPath, local_path: newPath }),
  })
  return handleResponse(res)
}

export async function moveItem(src: string, dst: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('/api/files/move', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ remote_path: src, local_path: dst }),
  })
  return handleResponse(res)
}

export async function deleteItem(path: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('/api/files/delete', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ remote_path: path }),
  })
  return handleResponse(res)
}

export async function copyItem(src: string, dst: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('/api/files/copy', {
    method: 'POST',
    headers: authHeaders(),
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
  const res = await fetch('/api/files/queue/add', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  return handleResponse(res) as Promise<{ ok: boolean; detail: string; op?: QueueOp }>
}

export async function queueStatus(): Promise<QueueStatusResponse> {
  const res = await fetch('/api/files/queue/status')
  return (await res.json()) as QueueStatusResponse
}

export async function queueCancel(opId: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`/api/files/queue/cancel/${opId}`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return handleResponse(res)
}
