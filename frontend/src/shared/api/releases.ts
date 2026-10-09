import { apiFetch } from './auth.ts'

export interface Release {
  guid: string
  title: string
  size: number
  quality: string
  indexer: string
  indexerId: number
  indexerFlags: string
  seeders: number
  leechers: number
  protocol: string
  releaseGroup: string
  languages: string[]
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
): Promise<ReleaseSearchStart> {
  try {
    const res = await apiFetch('/api/calendar/releases', {
      method: 'POST',
      body: JSON.stringify({ source, type, id }),
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
