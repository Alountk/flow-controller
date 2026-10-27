import { apiFetch } from './auth.ts'

/**
 * One row of `POST /api/calendar/releases` — the release shape the modal
 * renders (S5, calendario-directo). It is EXACTLY what our own sources
 * return (`_release_row` in backend/routes/calendar.py):
 * `{title, guid, link, size, indexer, source, seeders?}`.
 *
 * The core is required because every row carries it. Everything else is
 * optional with meaning:
 * - `link`/`source`/`seeders` are the direct rows' own fields — `seeders`
 *   only when the source stated one, `link` only when the row has one;
 * - `quality`, `languages`, `indexerId`, `indexerFlags`, `leechers`,
 *   `protocol` and `releaseGroup` are the ARR era's fields. The API never
 *   emits them any more, so the type never REQUIRES them: a missing key is
 *   absent, never `undefined` painted as text.
 */
export interface Release {
  guid: string
  title: string
  size: number
  indexer: string
  /** The fan-out source that produced the row (`torznab`/`amule`/`prowlarr`). */
  source?: string
  /** The row's built link — the grab's dispatch target when present. */
  link?: string
  /** Only when the source stated one (S1). */
  seeders?: number
  /** Legacy arr rows only — direct rows never carry the seven below. */
  quality?: string
  languages?: string[]
  indexerId?: number
  indexerFlags?: string
  leechers?: number
  protocol?: string
  releaseGroup?: string
}

/**
 * What `POST /api/calendar/releases` answers: a job to poll (`task_id`), or —
 * when validation refuses the request — the same synchronous body the
 * endpoint has always returned for a request that could never run
 * (`releases: []` + `detail`, with no task id).
 *
 * C-10: the POST used to await the arr inline — 91.6 s measured (Radarr × 20
 * indexers) against a proxy that cuts at ~60 s, so the request died as a 504
 * before any release could come back. It now answers in milliseconds; the
 * search itself runs as a job behind the backend's task_manager.
 */
export interface ReleaseSearchStart {
  ok?: boolean
  task_id?: string
  status?: string
  detail?: string
  releases?: Release[]
}

/**
 * What `GET /api/calendar/releases/{task_id}` answers: the task_manager
 * shape every task endpoint in this app already serves (`{"ok": true,
 * ...task}`). Once `status` is `done`, `releases` + `detail` inside the task
 * ARE the payload the synchronous POST used to return; on `error`, `detail`
 * is the exact `Error interno: ...` string that handler used to return, so
 * the failure reaches the same error step without a new branch.
 */
export interface ReleaseSearchTask {
  ok: boolean
  id?: string
  status?: string
  detail?: string
  releases?: Release[]
  error?: string
}

export async function startCalendarReleaseSearch(
  source: string,
  type: string,
  id: number,
  title: string,
  selection?: { sources?: string[]; indexer_ids?: number[] },
): Promise<ReleaseSearchStart> {
  try {
    // `title` is the query over OUR sources (S1) and the backend requires it:
    // a blank one is refused synchronously («Falta el título del ítem…»).
    // `selection` rides only when something was unchecked: absent keys keep
    // the backend's full fan-out (JSON.stringify drops undefined values).
    const res = await apiFetch('/api/calendar/releases', {
      method: 'POST',
      body: JSON.stringify({ source, type, id, title, ...selection }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>
      const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
      return { releases: [], detail: msg }
    }
    return await res.json() as ReleaseSearchStart
  } catch (err) {
    return { releases: [], detail: `Error de conexión: ${err}` }
  }
}

export async function fetchReleaseSearchStatus(taskId: string): Promise<ReleaseSearchTask> {
  try {
    const res = await apiFetch(`/api/calendar/releases/${encodeURIComponent(taskId)}`, {})
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>
      const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
      return { ok: false, detail: msg }
    }
    return await res.json() as ReleaseSearchTask
  } catch (err) {
    return { ok: false, detail: `Error de conexión: ${err}` }
  }
}
