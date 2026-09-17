import type { BrowseResponse, RootsResponse } from '../types'

const API_KEY = import.meta.env.VITE_API_KEY || ''

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (API_KEY) h['X-Api-Key'] = API_KEY
  return h
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
  return (await res.json()) as { ok: boolean; detail: string }
}

export async function renameItem(oldPath: string, newPath: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('/api/files/rename', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ remote_path: oldPath, local_path: newPath }),
  })
  return (await res.json()) as { ok: boolean; detail: string }
}

export async function moveItem(src: string, dst: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('/api/files/move', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ remote_path: src, local_path: dst }),
  })
  return (await res.json()) as { ok: boolean; detail: string }
}

export async function deleteItem(path: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('/api/files/delete', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ remote_path: path }),
  })
  return (await res.json()) as { ok: boolean; detail: string }
}
