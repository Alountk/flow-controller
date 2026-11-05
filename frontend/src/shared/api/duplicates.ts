import { apiFetch } from './auth.ts'

const BASE = '/api'

export interface DuplicateFile {
  path: string
  name: string
  size: number
  /** The class the duplicate rule compared: `4K`, `3D`, `1080` or `otros`. */
  class: string
  /**
   * True when Radarr tracks this exact file, false when it tracks another one,
   * null when Radarr did not answer and nothing can be claimed.
   */
  known: boolean | null
}

/**
 * Una película con copias de más. La detección sigue siendo por carpeta y clase
 * (`duplicate_folders` en el backend); esto es esa misma lista, agrupada por
 * título, porque la pregunta de la pantalla es «qué película tiene copias de más».
 */
export interface DuplicateTitleGroup {
  title: string
  folder: string
  folders: string[]
  /** Las clases que se repiten dentro del grupo, en el orden del backend. */
  classes: string[]
  files: DuplicateFile[]
  /** Bytes you get back by deleting only the files Radarr does not know. */
  reclaimable: number
}

export interface DuplicatesResponse {
  groups: DuplicateTitleGroup[]
  total: number
  /** Carpetas que repiten clase; `total` cuenta títulos. */
  folders?: number
  /** La carpeta a la que se acotó el recorrido; vacío = todas las raíces. */
  scope?: string
  roots?: string[]
  /** False when the arr did not answer: then `known` is null everywhere. */
  radarr?: boolean
  error?: string
  error_kind?: string
}

/**
 * Recorre la biblioteca y devuelve las carpetas que repiten un fichero.
 *
 * Es lento a propósito y sin progreso: el backend camina el disco en un hilo. Se
 * llama cuando el usuario pulsa el botón, nunca al montar la pantalla.
 */
export async function fetchDuplicates(
  path?: string,
  signal?: AbortSignal,
): Promise<DuplicatesResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const response = await apiFetch(`${BASE}/movies/duplicates${query}`, { signal })
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
