import { apiFetch, UnauthorizedError } from './auth.ts'
import type { DestinationOptions } from '../types.ts'

/**
 * Turn a thrown fetch into something the user can act on.
 *
 * `TypeError: Failed to fetch` is what the browser reports for offline, DNS and
 * CORS problems alike — repeating it verbatim tells the user nothing.
 */
function describeFetchFailure(err: unknown): string {
  if (err instanceof UnauthorizedError) {
    // apiFetch already triggered the key prompt; say what happened rather than
    // leaking the exception name.
    return 'API key rechazada. Vuelve a introducirla para continuar.'
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return 'La petición tardó demasiado y se canceló'
  }
  const name = err instanceof Error ? err.name : ''
  if (name === 'TypeError') {
    return 'No se pudo contactar con el servidor. Comprueba la conexión y que el backend siga activo'
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/**
 * The folders the user may choose as a grab destination.
 *
 * Never rejects: the combo has a built-in library default, so a failure here
 * must leave the modal usable rather than block searching or grabbing. A
 * failed load resolves to an empty list (plus the reason in `detail`).
 */
export async function fetchCalendarDestinations(source: string): Promise<DestinationOptions> {
  try {
    const res = await apiFetch(
      `/api/calendar/destinations?source=${encodeURIComponent(source)}`,
      {},
    )
    if (!res.ok) {
      return { folders: [], arr_available: false, detail: `HTTP ${res.status}` }
    }
    const body = await res.json() as Partial<DestinationOptions>
    return {
      folders: Array.isArray(body.folders) ? body.folders : [],
      arr_available: body.arr_available === true,
      detail: typeof body.detail === 'string' ? body.detail : '',
    }
  } catch (err) {
    return { folders: [], arr_available: false, detail: describeFetchFailure(err) }
  }
}

/**
 * What `POST /api/calendar/grab` answers: a job to poll (`task_id`), or —
 * when validation refuses the request — the same synchronous body the
 * endpoint has always returned for a request that could never run
 * (`ok` + `detail`, with no task id).
 *
 * async-grab: the POST used to await the whole chain inline — the ED2K
 * resolve alone measures 30-60 s against a proxy that cuts at ~60 s, so the
 * request died as a 504 while the download was already on its way. It now
 * answers in milliseconds; the grab itself runs as a job behind the
 * backend's task_manager and is collected at `fetchGrabStatus`.
 */
export interface GrabStart {
  ok: boolean
  detail: string
  task_id?: string
  status?: string
  /** Present on the settled payload: the download bypassed the arr. */
  direct?: boolean
}

/**
 * What `GET /api/calendar/grab/{task_id}` answers: the task_manager shape
 * every task endpoint in this app already serves (`{"ok": true, ...task}`).
 * Once `status` is `done`, `ok`/`detail`/`direct` inside the task ARE the
 * payload the synchronous POST used to return — where a settled `ok: false`
 * is a refusal the worker produced (the task ran fine), while a status read
 * that cannot find the task answers `error` and carries no `status` at all.
 * On `error`, `detail` is the exact `Error interno: ...` string the
 * synchronous handler used to return.
 */
export interface GrabTask {
  ok: boolean
  id?: string
  status?: string
  detail?: string
  direct?: boolean
  error?: string
}

export async function grabCalendarRelease(
  source: string,
  guid: string,
  link?: string,
  indexerId: number = 0,
  movieId: number = 0,
  episodeId: number = 0,
  destination?: string,
  quality?: string,
  is3d?: boolean,
  title?: string,
  library?: boolean,
  size?: number,
): Promise<GrabStart> {
  // A rejected fetch (offline, aborted, DNS) must surface as a failed result,
  // not as an unhandled rejection that leaves the modal stuck on "Descargando".
  // `destination` and `quality` are only added when set, so a library grab (the
  // default) sends the same body as before either option existed. The server
  // reads `quality` only when no destination was chosen: it routes, it never
  // overrides a folder the operator picked.
  const body: Record<string, unknown> = { source, guid, indexerId, movieId, episodeId }
  // S2: the dispatch target is `link or guid` — the client sends `link` when
  // the row has one (it is the row's built link, never a re-search) and the
  // backend falls back to the guid otherwise.
  if (link) body.link = link
  if (destination) body.destination = destination
  if (quality) body.quality = quality
  if (is3d) body.is3d = true
  // A foreign-destination grab goes DIRECT to the client (never through the
  // arr), and the backend resolves the download link from this title.
  if (title) body.title = title
  // Explicit "the arr's own path": without the flag the server would still
  // DERIVE a 2160p release to path_4k and quietly override this choice.
  if (library) body.library = true
  // The byte size is the tie-breaker when a suffixed guid matches several
  // items with the same base id — only size tells the release from its nfo.
  if (size) body.size = size
  let res: Response
  try {
    res = await apiFetch('/api/calendar/grab', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { ok: false, detail: describeFetchFailure(err) }
  }
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof errorBody.detail === 'string' ? errorBody.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg }
  }
  return res.json() as Promise<GrabStart>
}

/**
 * The settled (or still running) state of one grab job — the clone of
 * `fetchReleaseSearchStatus`, keyed by the task id the POST returned.
 *
 * Never rejects: a transport failure resolves to `{ok: false, detail}`,
 * which the poll reads as a failed status read instead of hanging on a
 * `running` task forever.
 */
export async function fetchGrabStatus(taskId: string): Promise<GrabTask> {
  try {
    const res = await apiFetch(`/api/calendar/grab/${encodeURIComponent(taskId)}`, {})
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>
      const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
      return { ok: false, detail: msg }
    }
    return await res.json() as GrabTask
  } catch (err) {
    return { ok: false, detail: `Error de conexión: ${err}` }
  }
}

export async function grabCalendarReleaseBatch(
  source: string,
  guids: string[],
  indexerIds: number[] = [],
  movieId: number = 0,
  episodeId: number = 0,
  destination?: string,
  quality?: string,
  is3d?: boolean,
): Promise<{ ok: boolean; detail: string; downloaded: string[]; errors: { guid: string; detail: string }[] }> {
  const body: Record<string, unknown> = { source, guids, indexerIds, movieId, episodeId }
  if (destination) body.destination = destination
  if (quality) body.quality = quality
  if (is3d) body.is3d = true
  let res: Response
  try {
    res = await apiFetch('/api/calendar/grab-batch', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { ok: false, detail: describeFetchFailure(err), downloaded: [], errors: [] }
  }
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof errorBody.detail === 'string' ? errorBody.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg, downloaded: [], errors: [] }
  }
  return res.json() as Promise<{ ok: boolean; detail: string; downloaded: string[]; errors: { guid: string; detail: string }[] }>
}
