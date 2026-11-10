/** La cola eD2K de aMule y su control por fichero (pagina-descargas S2/S3).
 *  El backend se escribe en paralelo contra este mismo contrato. */

import { apiFetch } from './auth.ts'
import type { AmuleDownloadRow } from '../types.ts'

export type AmuleDownloadAction = 'pause' | 'resume' | 'delete' | 'priority' | 'category'

export type AmuleDownloadsResponse =
  | { ok: true; downloads: AmuleDownloadRow[]; detail: string }
  | { ok: false; detail: string }

/** Cuerpo de `POST /api/amule/downloads/{action}`: sólo los campos que la
 *  acción lee. `category` es el ÍNDICE (la columna de valores del mapa de
 *  `GET /api/amule/categories`), no el título. */
export interface AmuleDownloadActionBody {
  file_hash: string
  priority?: number
  category?: number
  delete_files?: boolean
}

export interface AmuleActionResult {
  ok: boolean
  detail: string
}

export type AmuleCategoriesResponse =
  | { ok: true; categories: Record<string, number> }
  | { ok: false; detail: string }

export async function getAmuleDownloads(): Promise<AmuleDownloadsResponse> {
  const res = await apiFetch('/api/amule/downloads', {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<AmuleDownloadsResponse>
}

export async function amuleDownloadsAction(
  action: AmuleDownloadAction,
  body: AmuleDownloadActionBody,
): Promise<AmuleActionResult> {
  const res = await apiFetch(`/api/amule/downloads/${action}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<AmuleActionResult>
}

export async function getAmuleCategories(): Promise<AmuleCategoriesResponse> {
  const res = await apiFetch('/api/amule/categories', {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<AmuleCategoriesResponse>
}
