import { apiFetch } from './auth.ts'

/**
 * «Indexadores» — the direct-connection registry («indexadores-directos» T6/S5).
 *
 * Shapes are the backend contracts of `backend/interfaces/http/routes/indexers.py`
 * verbatim — no invented fields:
 *
 * - every response carries `api_key` MASKED (`****` + last characters) and a
 *   PUT with an EMPTY or masked key keeps the stored one;
 * - `POST /{id}/test` is a probe: 200 `{ok, caps}` or `{ok, false, detail}`;
 * - `POST /api/indexers/search` answers `{ok, results, skipped}` (plus
 *   `detail` when EVERY source failed) with rows that always carry
 *   `source`/`name`/`size` and only ever carry `indexer`/`seeders`/`sources`
 *   (aMule — never seeders)/`infohash`/`link`/`guid` when the source reported
 *   them; `skipped` is `[{source, reason}]`;
 * - `POST /api/indexers/download` (the L6 amendment: never
 *   `POST /api/calendar/grab`) answers 200 `{ok, detail}` in BOTH directions.
 *
 * The mold is `releases.ts`/`grabs.ts`: nothing here rejects on a failed
 * request — the failure travels in the body (`detail`/`error`) so the panel
 * can show it. The list query hands React Query's abort signal to `apiFetch`
 * (B-12), which propagates it to `fetch`.
 */

/** The searchable sources, in the backend's canonical order. */
export const INDEXER_SOURCES = ['torznab', 'amule', 'prowlarr'] as const
export type IndexerSearchSource = (typeof INDEXER_SOURCES)[number]

/** One registry row as every response shows it — `api_key` already masked. */
export interface IndexerRow {
  id: number
  name: string
  url: string
  api_key: string
  categories: string
  enabled: number
  created_at?: number
  updated_at?: number
}

/** `GET /api/indexers` — an unavailable store is an empty list WITH a reason. */
export interface IndexerListResponse {
  indexers: IndexerRow[]
  error?: string
}

/** What the add/edit form posts. `api_key` empty = keep the stored key. */
export interface IndexerInput {
  name: string
  url: string
  api_key?: string
  categories?: string
  enabled?: boolean
}

export interface IndexerSaveResult {
  ok: boolean
  indexer?: IndexerRow
  detail?: string
}

export interface IndexerDeleteResult {
  ok: boolean
  detail?: string
}

/** The `t=caps` probe payload — the Torznab capabilities document. */
export interface IndexerCaps {
  searches?: Record<string, unknown>
  categories?: { id?: number; name?: string }[]
  [key: string]: unknown
}

export interface IndexerTestResult {
  ok: boolean
  caps?: IndexerCaps
  detail?: string
}

/** One search row: always `source`/`name`/`size`, the rest only when real. */
export interface IndexerSearchRow {
  source: string
  name: string
  size: number | null
  indexer?: string
  seeders?: number
  /** aMule's ED2K source count — NEVER seeders, different magnitude. */
  sources?: number
  infohash?: string
  link?: string
  guid?: string
}

export interface IndexerSearchSkipped {
  source: string
  reason: string
}

export interface IndexerSearchResponse {
  ok: boolean
  results: IndexerSearchRow[]
  skipped: IndexerSearchSkipped[]
  detail?: string
}

export interface IndexerDownloadResult {
  ok: boolean
  detail: string
}

/** `detail` from the body, or the status when the body has none. */
async function readDetail(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  return (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
}

function describeFailure(err: unknown): string {
  return `Error de conexión: ${err}`
}

export async function fetchIndexers(signal?: AbortSignal): Promise<IndexerListResponse> {
  try {
    const res = await apiFetch('/api/indexers', { signal })
    if (!res.ok) return { indexers: [], error: await readDetail(res) }
    const body = await res.json() as Partial<IndexerListResponse>
    return {
      indexers: Array.isArray(body.indexers) ? body.indexers : [],
      ...(typeof body.error === 'string' ? { error: body.error } : {}),
    }
  } catch (err) {
    return { indexers: [], error: describeFailure(err) }
  }
}

export async function createIndexer(input: IndexerInput): Promise<IndexerSaveResult> {
  try {
    const res = await apiFetch('/api/indexers', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    if (!res.ok) return { ok: false, detail: await readDetail(res) }
    const body = await res.json() as IndexerSaveResult
    return { ok: body.ok === true, indexer: body.indexer, detail: body.detail }
  } catch (err) {
    return { ok: false, detail: describeFailure(err) }
  }
}

export async function updateIndexer(id: number, patch: Partial<IndexerInput>): Promise<IndexerSaveResult> {
  try {
    const res = await apiFetch(`/api/indexers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    if (!res.ok) return { ok: false, detail: await readDetail(res) }
    const body = await res.json() as IndexerSaveResult
    return { ok: body.ok === true, indexer: body.indexer, detail: body.detail }
  } catch (err) {
    return { ok: false, detail: describeFailure(err) }
  }
}

export async function deleteIndexer(id: number): Promise<IndexerDeleteResult> {
  try {
    const res = await apiFetch(`/api/indexers/${id}`, { method: 'DELETE' })
    if (!res.ok) return { ok: false, detail: await readDetail(res) }
    const body = await res.json() as IndexerDeleteResult
    return { ok: body.ok === true, detail: body.detail }
  } catch (err) {
    return { ok: false, detail: describeFailure(err) }
  }
}

/** The `t=caps` probe — always 200, truth in `ok`/`caps`/`detail`. */
export async function testIndexer(id: number): Promise<IndexerTestResult> {
  try {
    const res = await apiFetch(`/api/indexers/${id}/test`, { method: 'POST' })
    if (!res.ok) return { ok: false, detail: await readDetail(res) }
    const body = await res.json() as IndexerTestResult
    return { ok: body.ok === true, caps: body.caps, detail: body.detail }
  } catch (err) {
    return { ok: false, detail: describeFailure(err) }
  }
}

/**
 * `POST /api/indexers/search` — the unified free search. The optional third
 * argument is the «alternativa-indexadores» T3/S3 amendment: when provided,
 * `indexer_ids` rides the body (the registry rows the alternative checklist
 * picked). When omitted — every Settings caller — the body is byte-identical
 * to the pre-amendment `{query, sources}` one.
 */
export async function searchIndexers(
  query: string,
  sources: IndexerSearchSource[],
  indexerIds?: number[],
): Promise<IndexerSearchResponse> {
  try {
    const payload: Record<string, unknown> = { query, sources }
    if (indexerIds) payload.indexer_ids = indexerIds
    const res = await apiFetch('/api/indexers/search', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      return { ok: false, results: [], skipped: [], detail: await readDetail(res) }
    }
    const body = await res.json() as Partial<IndexerSearchResponse>
    return {
      ok: body.ok === true,
      results: Array.isArray(body.results) ? body.results : [],
      skipped: Array.isArray(body.skipped) ? body.skipped : [],
      detail: typeof body.detail === 'string' ? body.detail : undefined,
    }
  } catch (err) {
    return { ok: false, results: [], skipped: [], detail: describeFailure(err) }
  }
}

/**
 * One free-search row straight to a client (the L6 amendment): `link ?? guid`
 * as the target, dispatched by shape server-side. 200 `{ok, detail}` in both
 * directions — only a malformed body is a 400.
 */
export async function downloadIndexer(target: {
  link?: string
  guid?: string
}): Promise<IndexerDownloadResult> {
  const body: Record<string, string> = {}
  if (target.link) body.link = target.link
  if (target.guid) body.guid = target.guid
  try {
    const res = await apiFetch('/api/indexers/download', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!res.ok) return { ok: false, detail: await readDetail(res) }
    const data = await res.json() as Partial<IndexerDownloadResult>
    return {
      ok: data.ok === true,
      detail:
        typeof data.detail === 'string' && data.detail
          ? data.detail
          : data.ok
            ? 'Descarga aceptada'
            : 'No se pudo completar la descarga',
    }
  } catch (err) {
    return { ok: false, detail: describeFailure(err) }
  }
}
