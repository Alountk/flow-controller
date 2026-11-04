import { apiFetch } from './auth.ts'

const BASE = '/api'

export interface DuplicateFile {
  path: string
  size: number
  quality: string
  title: string
}

export interface DuplicateGroup {
  tmdb_id: number
  class: string
  titles: string[]
  files: DuplicateFile[]
}

export interface DuplicatesResponse {
  groups: DuplicateGroup[]
  total: number
  error?: string
  error_kind?: string
}

export async function fetchDuplicates(signal?: AbortSignal): Promise<DuplicatesResponse> {
  const response = await apiFetch(`${BASE}/movies/duplicates`, { signal })
  if (!response.ok) throw new Error(`No se pudo buscar duplicados (HTTP ${response.status})`)
  return response.json()
}

/** Borra un fichero concreto. El backend rechaza con motivo si no procede. */
export async function deleteDuplicate(path: string): Promise<{ deleted: string }> {
  const response = await apiFetch(`${BASE}/movies/duplicates/delete`, {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.detail || `No se pudo borrar (HTTP ${response.status})`)
  return body
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}
