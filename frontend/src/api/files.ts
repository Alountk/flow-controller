import type { BrowseResponse, RootsResponse } from '../types'

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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remote_path: path }),
  })
  return (await res.json()) as { ok: boolean; detail: string }
}

export async function renameItem(oldPath: string, newPath: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('/api/files/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remote_path: oldPath, local_path: newPath }),
  })
  return (await res.json()) as { ok: boolean; detail: string }
}

export async function moveItem(src: string, dst: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('/api/files/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remote_path: src, local_path: dst }),
  })
  return (await res.json()) as { ok: boolean; detail: string }
}

export async function deleteItem(path: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('/api/files/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remote_path: path }),
  })
  return (await res.json()) as { ok: boolean; detail: string }
}
