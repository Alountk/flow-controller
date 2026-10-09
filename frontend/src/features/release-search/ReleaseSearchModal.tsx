import { Fragment, useState, useRef, useCallback, useEffect } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { addCalendarItem } from '../../shared/api/calendar.ts'
import {
  startCalendarReleaseSearch,
  fetchReleaseSearchStatus,
  type Release,
  type ReleaseSearchTask,
} from '../../shared/api/releases.ts'
import { grabCalendarRelease } from '../../shared/api/grabs.ts'
import { apiFetch } from '../../shared/api/auth.ts'
import type { BrowseResponse, FileItem } from '../../shared/types.ts'
import { looksThreeD } from '../../shared/utils/threeD.ts'
import { toast } from '../../shared/utils/toast.ts'
import {
  NO_RELEASE_FILTERS,
  collectLanguages,
  collectQualities,
  filterReleases,
  hasActiveFilters,
  toggleInSet,
  type ReleaseFilters,
} from '../../shared/utils/releaseFilters.ts'
import './ReleaseSearchModal.css'

interface Indexer {
  id: number
  name: string
  implementation: string
  enableSearch: boolean
}

/** Which kind of id a `ReleaseSearchItem.id` carries — the three the grabs
 *  history can be asked under, one query parameter each. */
export type ReleaseIdKind = 'movie' | 'episode' | 'series'

export interface ReleaseSearchItem {
  type: 'movie' | 'episode'
  id: number
  title: string
  source: string // 'radarr' | 'sonarr'
  date?: string
  year?: number | null
  has_file?: boolean
  remotePoster?: string
  series_title?: string | null
  season_number?: number | null
  episode_number?: number | null
  /** The downloaded file's name (`movieFile.relativePath`), when the surface
   *  that built this item carries it — the sections' rows do, the calendar's
   *  cards do not. Absent means "this view cannot say": the has-file block
   *  degrades to an explicit "not available" instead of inventing a name. */
  file_name?: string
  /** Languages of THAT file, when the surface carries them. Absent or empty
   *  renders nothing at all — no dash, no "sin idioma". */
  languages?: string[]
  /** Quality of the file Radarr owns, when the surface carries it. Absent or
   *  "" is unknown: every quality tag stays grey, never a guessed class. */
  quality?: string
  /** The title's folder, the one signal the 3D tag reads (path_3d membership). */
  path?: string
  /** What `id` IS, when the surface knows better than `type` can say. A
   *  Series card is typed `episode` — the only thing Sonarr can grab — while
   *  carrying the SERIES id, and asking the grabs history for that under
   *  `episode_id` returns a DIFFERENT show's episode with the same number:
   *  a lit tag for a class this series does not have. Absent → derived from
   *  `type` (movie → movie_id, anything else → episode_id), which is the
   *  answer for every surface whose ids cannot be confused. */
  idKind?: ReleaseIdKind
}

type ModalStep = 'initial' | 'searching' | 'adding' | 'results' | 'grabbing' | 'done' | 'error'

const SEARCH_TIMEOUT = 240 // seconds — must match backend REQUEST_TIMEOUT * 48

/** Job statuses the release-search poll stops at: `done` carries the result,
 *  `error` the reason. Anything else keeps the query refetching — the same
 *  terminal-set idea TraceActions applies to copy tasks. */
const TERMINAL_STATUSES = ['done', 'error']

function formatSize(bytes: number): string {
  if (bytes === 0) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

/** The facts under a file's name — `idioma · calidad · size · semillas`, in
 *  the order the operator reads them. An empty `languages` array contributes
 *  NOTHING, not even a separator: the `·` is a node between rendered spans,
 *  so it can never appear in front of a missing field. */
function releaseMetaParts(r: Release): { className: string; text: string }[] {
  const parts: { className: string; text: string }[] = []
  if (r.languages && r.languages.length > 0) {
    parts.push({ className: 'release-lang', text: r.languages.join(', ') })
  }
  if (r.quality) parts.push({ className: 'release-quality', text: r.quality })
  parts.push(
    { className: 'release-size', text: formatSize(r.size) },
    { className: 'release-seeders', text: `⬆ ${r.seeders} / ⬇ ${r.leechers}` },
  )
  return parts
}

function groupByIndexer(releases: Release[]): Map<string, Release[]> {
  const map = new Map<string, Release[]>()
  for (const r of releases) {
    const key = r.indexer || 'Desconocido'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(r)
  }
  return map
}

interface RoutingFolders {
  path4k: string
  path3d: string
}

/** The two routing folders, from GET /api/settings — the same document
 *  backend/config.py rebuilds PATH_4K/PATH_3D from, and the exact one the
 *  Calidad view already reads. Shared ['routing-folders'] key, so a section
 *  that opened Calidad first never fetches this twice. */
async function fetchRoutingFolders(): Promise<RoutingFolders> {
  const res = await apiFetch('/api/settings', {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { paths?: { path_4k?: string; path_3d?: string } }
  return {
    path4k: (body.paths?.path_4k ?? '').trim(),
    path3d: (body.paths?.path_3d ?? '').trim(),
  }
}

/** One row of GET /api/grabs — a download THIS app made for ONE title, oldest
 *  first. `quality` and `destination` are null on rows older than those
 *  columns: null is unknown, never "" — an empty quality name must not be
 *  rendered as if the arr had reported it. */
interface OwnGrab {
  quality: string | null
  destination: string | null
  grabbed_at: number | null
}

/** The query parameter each id kind is asked under — the exact names
 *  GET /api/grabs accepts, one per kind, so a Series card can never be
 *  mistaken for an episode by a string built from `type` alone. */
const GRABS_ID_PARAM: Record<ReleaseIdKind, string> = {
  movie: 'movie_id',
  episode: 'episode_id',
  series: 'series_id',
}

/** The app's own grabs for ONE title — the second source behind the has-file
 *  tags. Anything that is not a real answer (HTTP failure, the `error` field
 *  the backend reports when the history cannot be read, a body without the
 *  `grabs` array) THROWS: a failed read is "unknown", never `[]` — `[]` would
 *  say "we have nothing", which is exactly the misread this feature exists to
 *  prevent. The caller then leaves the tags as the library said. */
async function fetchOwnGrabs(
  source: string,
  kind: ReleaseIdKind,
  id: number,
): Promise<OwnGrab[]> {
  const res = await apiFetch(
    `/api/grabs?source=${encodeURIComponent(source)}&${GRABS_ID_PARAM[kind]}=${id}`,
    {},
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { grabs?: OwnGrab[]; error?: string }
  if (body.error || !Array.isArray(body.grabs)) {
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return body.grabs
}

/** The top-level entries of ONE routing folder — the third source behind the
 *  has-file tags. An unreadable folder (`ok: false`: not a directory, no
 *  permission) throws for the same reason a transport failure does: it must
 *  leave the tags untouched instead of reading as "the folder is empty". */
async function fetchRoutingListing(folder: string): Promise<FileItem[]> {
  const res = await apiFetch(`/api/files/browse?path=${encodeURIComponent(folder)}`, {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as BrowseResponse
  if (!body.ok || !Array.isArray(body.items)) throw new Error(body.error || `HTTP ${res.status}`)
  return body.items
}

/**
 * The panel's results, per ITEM, across the tab switches that unmount it.
 *
 * The Releases view is conditionally rendered, so leaving it destroys
 * everything — and re-opening the tab would then sit on the initial step
 * with a 🔍 button over a search that can take 240 seconds and already
 * returned. Keyed by source/type/id (never by visit): a different title is
 * a different search, the same title is the same results — a re-open mounts
 * straight on 'results' and does nothing. Session-scoped module state:
 * overlay presentations never read or write it.
 */
const panelResults = new Map<
  string,
  { indexer: string; releases: Release[]; threeDOverrides: Record<string, boolean> }
>()

const LIBRARY = 'Biblioteca (la del arr)'

/**
 * True when `path` is `folder` or lives under it. An unconfigured folder ("")
 * matches nothing: empty means "not configured", never "everything". Same rule
 * the Calidad views already read `path_4k`/`path_3d` membership with, kept
 * local because both of those keep their own copy too.
 */
function inFolder(path: string, folder: string): boolean {
  if (!path || !folder) return false
  const root = folder.endsWith('/') ? folder.slice(0, -1) : folder
  return path === root || path.startsWith(`${root}/`)
}

/**
 * The name `path` ends in — the string this app's copies keep at the FRONT of
 * their entry name inside a routing folder: `path_4k/<name>/<file>` after the
 * rename logic, and `path_4k/<name>….mkv` flat for the historical copies, so
 * a prefix test covers both layouts (exact equality would miss every flat
 * one). A path with no segments yields "", which must never be used as a
 * prefix: every string starts with "", so an absent `path` would "find" a
 * copy of this title in every entry of every folder.
 */
function baseName(path: string): string {
  const clean = path.replace(/\/+$/, '')
  const at = clean.lastIndexOf('/')
  return at === -1 ? clean : clean.slice(at + 1)
}

/**
 * One component, two presentations.
 *
 * Overlay mode is the modal this app has always opened: `onClose` is required
 * and Escape/backdrop/close-button all end the dialog. Panel mode has no
 * dialog to end, so it takes no `onClose` at all — the type makes that
 * impossible to get wrong.
 */
export type ReleaseSearchModalProps = { item: ReleaseSearchItem } & (
  | { presentation?: 'overlay'; onClose: () => void }
  | { presentation: 'panel'; onClose?: undefined }
)

export function ReleaseSearchModal({
  item,
  onClose,
  presentation = 'overlay',
}: ReleaseSearchModalProps) {
  const inPanel = presentation === 'panel'
  // The population the panel's 🔍 Buscar Releases button serves: a title
  // that still needs a file, and one already inside the library (id 0 must
  // be ADDED first — its ➕ button's job). The same gate guards the
  // indexer-change re-run and the results cache, so a title that already has
  // its file never searches from out here: it meets the has-file block,
  // whose "Buscar versiones" button searches on demand instead.
  // Selection itself is NOT a trigger: the operator initiates, always.
  const autoSearchable = !item.has_file && item.id !== 0
  // A re-open of the panel lands straight back on the results this item
  // already produced (see panelResults); the overlay — and an item that no
  // longer needs a search — always start fresh.
  const restored =
    inPanel && autoSearchable
      ? panelResults.get(`${item.source}:${item.type}:${item.id}`)
      : undefined
  const [step, setStep] = useState<ModalStep>(restored ? 'results' : 'initial')
  const [message, setMessage] = useState('')
  // PANEL ONLY: the acknowledgement of a grab that landed while the results
  // STAYED on screen. It is a separate state on purpose: `message` carries
  // search/step feedback ("Buscando releases…"), and a results render must
  // never show that stale string as if it were news.
  const [notice, setNotice] = useState('')
  const [selectedIndexer, setSelectedIndexer] = useState<string>(restored?.indexer ?? 'all')
  const [releases, setReleases] = useState<Release[]>(restored?.releases ?? [])
  const [filters, setFilters] = useState<ReleaseFilters>(NO_RELEASE_FILTERS)
  // Per-row corrections to the 3D suggestion. An absent guid means "no human
  // has spoken, trust the title"; present means "this is what I said".
  const [threeDOverrides, setThreeDOverrides] = useState<Record<string, boolean>>(
    restored?.threeDOverrides ?? {},
  )
  const [elapsed, setElapsed] = useState(0)
  // C-10: the release search is a job now. This is its handle while the poll
  // runs — null whenever no search is in flight.
  const [releaseJob, setReleaseJob] = useState<{ task_id: string; status: string } | null>(null)
  // The indexer choice of the in-flight search: `handleSearch` receives it as
  // a parameter, and the results must be filtered under THAT choice when the
  // job completes, not under whatever the select says by then.
  const pendingChoice = useRef<string>('all')
  const modalRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Once-per-mount guard for the panel's 🔍 button: a second click in the
  // same tick must not fire two 240-second searches. It is the same guard
  // the removed mount auto-search owned, riding on the ONE trigger that is
  // left — the panel never returns to 'initial' (nothing calls
  // setStep('initial')), so one press per mount is all the operator gets
  // before Refrescar/Nueva búsqueda take over. Overlay presses stay unguarded.
  const autoSearched = useRef(false)

  // Overlay only: the panel is not a dialog, so it never owns a backdrop or
  // an Escape key — there is nothing for either of them to close.
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose?.()
  }, [onClose])

  useEffect(() => {
    if (inPanel) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, inPanel])

  // Cached per SOURCE. Asking Radarr once must not ask it again a few minutes
  // later, and Sonarr's list is a different list — that separation is the cache
  // key. The previous behaviour (a bare `useEffect` with `.catch(() => {})`)
  // threw the failure away, so a Radarr timeout looked exactly like "there are
  // no indexers": `[]` in, `[]` out, nothing on screen.
  const indexersQuery = useQuery({
    queryKey: ['indexers', item.source],
    queryFn: async () => {
      const res = await apiFetch(`/api/calendar/indexers?source=${item.source}`, {})
      const data = (await res.json()) as { indexers?: Indexer[]; error?: string }
      // The backend reports its own failures in the body, so HTTP 200 can still
      // mean "I could not ask Radarr". Either way this must NOT become an empty
      // list: an empty list means "none configured" and is shown as such.
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      return data.indexers ?? []
    },
    staleTime: 5 * 60_000,
    retry: 1,
    placeholderData: keepPreviousData,
  })
  const indexers = indexersQuery.data ?? []


  // The routing folders behind the readout: only the results step shows it, so
  // only the results step asks. A failed read must never read as "not
  // configured" — the backend still has its own copy and routes with it.
  const foldersQuery = useQuery({
    queryKey: ['routing-folders'],
    queryFn: fetchRoutingFolders,
    // Two consumers, one fetch: the results step draws the routing readout,
    // and the has-file block needs the same folders EARLIER — its 3D tag is
    // "`path` inside `path_3d`". A failed read still lights nothing: 3D can
    // only be claimed from a folder we actually read.
    enabled: step === 'results' || (step === 'initial' && !!item.has_file),
    retry: false,
  })
  const path4k = foldersQuery.data?.path4k ?? ''
  const path3d = foldersQuery.data?.path3d ?? ''
  const foldersUnreadable = foldersQuery.isError

  // ── The has-file block's other two sources ─────────────────────────────────
  // The tags are drawn on the initial step, for a title that HAS a file, and
  // only then may any of these ask — no request on mount for an item with no
  // file. Each query is keyed by what it is ABOUT: grabs by source:type:id (a
  // different title is a different history), the listings by folder path (the
  // folder does not change with the selection, so a whole session browses
  // path_4k and path_3d at most once each — two calls, not one per item). The
  // settings document needs no new key at all: ['routing-folders'] above is
  // the same one the Calidad view reads.
  const blockShown = step === 'initial' && !!item.has_file

  // Which id `item.id` IS: the surface says when it knows (a Series card is
  // `type:'episode'` but carries the SERIES id), the type decides when it
  // cannot be wrong. Keyed with the kind because the kind changes the URL —
  // a series and an episode of the same number are different histories.
  const grabsIdKind: ReleaseIdKind =
    item.idKind ?? (item.type === 'movie' ? 'movie' : 'episode')

  const grabsQuery = useQuery({
    queryKey: ['grabs', item.source, grabsIdKind, item.id],
    queryFn: () => fetchOwnGrabs(item.source, grabsIdKind, item.id),
    enabled: blockShown,
    // Terminal on purpose: an errored history must settle as "unknown" (the
    // tags keep whatever the sources that DID answer said) instead of being
    // retried into the backend on every render of the block.
    retry: false,
  })

  // An unconfigured folder ("" while the settings read is pending, failed, or
  // reporting it unconfigured) never enables its query: a folder that does not
  // exist cannot hold a copy, and the request would be refused anyway.
  const listing4kQuery = useQuery({
    queryKey: ['routing-listing', path4k],
    queryFn: () => fetchRoutingListing(path4k),
    enabled: blockShown && !!path4k,
    retry: false,
    // Settings, not live data — same 5-minute window Calidad gives them, and
    // the reason a selection change costs zero browse calls.
    staleTime: 5 * 60_000,
  })
  const listing3dQuery = useQuery({
    queryKey: ['routing-listing', path3d],
    queryFn: () => fetchRoutingListing(path3d),
    enabled: blockShown && !!path3d,
    retry: false,
    staleTime: 5 * 60_000,
  })

  // An unconfigured folder ("" while the settings read is pending, failed, or
  // reporting it unconfigured) never enables its query: a folder that does not
  // exist cannot hold a copy, and the request would be refused anyway.



  // NO MOUNT TRIGGER — selecting a row never searches: the operator presses
  // 🔍 Buscar Releases below (or the has-file block's "Buscar versiones", or
  // an id 0 item's ➕). The one remaining automatic trigger is the indexer
  // <select>: changing it re-runs the search (PR B's requirement).

  // Keep the cached state of this item truthful while the panel changes it,
  // so the next tab switch restores what the operator actually left behind.
  useEffect(() => {
    if (!inPanel || step !== 'results' || releases.length === 0) return
    panelResults.set(`${item.source}:${item.type}:${item.id}`, {
      indexer: selectedIndexer,
      releases,
      threeDOverrides,
    })
  }, [inPanel, step, item.source, item.type, item.id, selectedIndexer, releases, threeDOverrides])

  // Timer for loading state
  useEffect(() => {
    if (step === 'searching' || step === 'adding') {
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000)
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [step])

  // ── C-10: the search as a job, polled ──────────────────────────────────────
  // The POST only starts the job; this is the other half — the pattern
  // TraceActions already uses for copy tasks: a react-query query keyed by
  // the task id, refetched every 1.5 s, stopping at a terminal status. No
  // request outlives the proxy's ~60 s cut, so the 504 class of 2026-10-07
  // cannot happen again: the slowest search is now a series of fast polls.
  const releaseJobQuery = useQuery({
    queryKey: ['release-task', releaseJob?.task_id],
    queryFn: () => fetchReleaseSearchStatus(releaseJob!.task_id),
    enabled: !!releaseJob && !TERMINAL_STATUSES.includes(releaseJob.status),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data as ReleaseSearchTask | undefined
      if (data && TERMINAL_STATUSES.includes(data.status ?? '')) return false
      return 1500
    },
  })

  /**
   * What `handleSearch` used to do with the POST's answer, applied identically
   * to whatever the job delivers: filter by the chosen indexer, render the
   * results, or land on the error step with the backend's own detail. The
   * payload itself (`releases` + `detail`) is unchanged from the synchronous
   * contract, so this logic did not have to learn anything new.
   */
  function applyReleaseResult(result: { releases: Release[]; detail: string }, choice: string) {
    const selectedName = choice === 'all'
      ? null
      : indexers.find(i => String(i.id) === choice)?.name
    const filtered = choice === 'all'
      ? result.releases
      : result.releases.filter(r => r.indexer === selectedName)
    if (filtered.length > 0) {
      setReleases(filtered)
      // A new search is a new list: whatever was corrected against the old
      // rows would otherwise be applied, silently, to different releases.
      setThreeDOverrides({})
      setStep('results')
    } else {
      setStep('error')
      if (choice !== 'all' && result.releases.length > 0) {
        const nameFound = indexers.find(i => String(i.id) === choice)?.name || choice
        setMessage(`${nameFound}: 0 releases encontrados. Hay ${result.releases.length} releases en total en otros indexadores.`)
      } else {
        setMessage(result.detail || 'No se encontraron releases. Verifica que los indexadores estén configurados.')
      }
    }
  }

  // Settle the job where `handleSearch` used to settle the POST's answer —
  // same filtering, same empty-result error, same message strings: the step
  // machine never learns it is now reading a poll. A `running` status does
  // nothing here; the query above keeps asking.
  useEffect(() => {
    const data = releaseJobQuery.data
    if (!releaseJob || !data) return
    if (!data.ok) {
      // The task is gone (TTL expired, backend restarted) or the status read
      // itself failed: a poll that cannot answer is an error, never a hang.
      setReleaseJob(null)
      setStep('error')
      setMessage(data.detail || data.error || 'Error obteniendo estado de tarea')
      return
    }
    if (data.status === 'done') {
      const choice = pendingChoice.current
      setReleaseJob(null)
      applyReleaseResult({ releases: data.releases ?? [], detail: data.detail ?? '' }, choice)
    } else if (data.status === 'error') {
      // The job's `detail` is the exact `Error interno: ...` string the
      // synchronous POST used to return — same error channel, same step.
      setReleaseJob(null)
      setStep('error')
      setMessage(data.detail || 'La búsqueda de releases falló')
    }
  }, [releaseJobQuery.data, releaseJob])

  /**
   * `choice` is the indexer the search runs under. It is a real parameter,
   * not state, because the panel's auto-search on an indexer change fires in
   * the same tick as setSelectedIndexer — reading state there would search
   * under the PREVIOUS choice. The overlay passes nothing (its button always
   * searches what the select already shows).
   */
  async function handleSearch(choice: string = selectedIndexer) {
    setStep('searching')
    // A new search is a new list: the previous grab's ack belongs to the old
    // one and must not ride above results that have not been fetched yet.
    setNotice('')
    const idxName = choice !== 'all' ? (indexers.find(i => String(i.id) === choice)?.name || '') : ''
    setMessage(`Buscando releases${idxName ? ` en ${idxName}` : ' en todos los indexadores'}...`)
    try {
      const started = await startCalendarReleaseSearch(item.source, item.type, item.id)
      if (started.task_id) {
        // C-10: the POST only starts the job. The results arrive through the
        // status poll above and are applied by the effect with THIS choice.
        pendingChoice.current = choice
        setReleaseJob({ task_id: started.task_id, status: started.status ?? 'running' })
        return
      }
      // No task id = a request that never became a job: the backend's own
      // refusal (unknown service or type) or a transport failure, answered
      // with the same detail the synchronous endpoint always carried.
      applyReleaseResult({ releases: started.releases ?? [], detail: started.detail ?? '' }, choice)
    } catch (err) {
      setStep('error')
      setMessage(`Error inesperado: ${err}`)
    }
  }

  async function handleAddAndSearch() {
    setStep('adding')
    setMessage('Agregando a biblioteca...')
    try {
      const result = await addCalendarItem(
        item.source,
        item.type,
        item.series_title || item.title,
        item.year ?? undefined,
      )
      if (result.ok && result.id) {
        item.id = result.id
        handleSearch()
      } else {
        setStep('error')
        setMessage(result.detail)
      }
    } catch (err) {
      setStep('error')
      setMessage(`Error inesperado: ${err}`)
    }
  }

  /** What a row actually is: a human correction if there is one, else the suggestion. */
  function isThreeD(r: Release): boolean {
    const override = threeDOverrides[r.guid]
    return override === undefined ? looksThreeD(r.title) : override
  }

  function toggleThreeD(guid: string) {
    const release = releases.find((r) => r.guid === guid)
    if (!release) return
    setThreeDOverrides((prev) => ({ ...prev, [guid]: !isThreeD(release) }))
  }

  /**
   * One row, one destination, one call — the three per-card buttons ARE the
   * choice (F-12): `library` is an explicit flag (a derived 2160p route would
   * otherwise override "→ Biblioteca"), the folders are the row's own
   * configured routing folders, and 3D forces the flag the chip suggests.
   */
  /** Where this row lands when nobody pressed a button: the same three rules
   *  the backend routes with, resolved here only to SUGGEST a button. */
  function destinationFor(r: Release): string {
    if (foldersUnreadable) return 'la que decida el backend (configuración ilegible)'
    if (isThreeD(r) && path3d) return path3d
    if (r.quality.trim().toLowerCase().endsWith('2160p') && path4k) return path4k
    return LIBRARY
  }

  async function handleGrab(guid: string, target: 'library' | '4k' | '3d') {
    setStep('grabbing')
    setNotice('')
    // The resolve can legitimately take ~30-60 s (the ED2K search is
    // throttled server-side, measured): silence there is the experience the
    // user reported. Say what is happening and how long it may take.
    setMessage('Enviando la descarga al servidor… el indexador de aMule puede tardar hasta un minuto.')
    const release = releases.find(r => r.guid === guid)
    const destination = target === '4k' ? path4k : target === '3d' ? path3d : undefined
    const is3d = target === '3d' ? true : release ? isThreeD(release) : undefined
    const result = await grabCalendarRelease(
      item.source,
      guid,
      release?.indexerId || 0,
      item.type === 'movie' ? item.id : 0,
      item.type === 'episode' ? item.id : 0,
      destination || undefined,
      release?.quality || undefined,
      is3d,
      release?.title,
      target === 'library' || undefined,
      release?.size || undefined,
    )
    if (result.ok) {
      // The backend's own detail distinguishes the paths — "directa: el arr no
      // la verá" vs "Release encolado" — so the ack shows it instead of a
      // fixed phrase that would hide which one happened.
      const ack = result.detail || 'Descarga iniciada. Revisa la cola de descargas.'
      // Ambient confirmation (F-13): the surfaces above stay where they are
      // (the panel's in-list ack, the dialog's done step) — the toast is what
      // reaches the operator who has already looked away.
      toast(ack, 'ok')
      if (inPanel) {
        // PANEL: the list is the product. The results the operator still
        // needs stay on screen, the ack rides above them, and nothing cached
        // is thrown away.
        setNotice(ack)
        setStep('results')
      } else {
        // The overlay IS a dialog: it ends on 'done' with its exit, as ever.
        setStep('done')
        setMessage(ack)
      }
    } else {
      setStep('error')
      setMessage(result.detail)
      toast(result.detail, 'error')
    }
  }

  const isProcessing = step === 'searching' || step === 'adding' || step === 'grabbing'

  // Options come from the FULL result set, so they do not vanish as you filter.
  const qualityOptions = collectQualities(releases)
  const languageOptions = collectLanguages(releases)
  const visibleReleases = filterReleases(releases, filters)
  const filtersActive = hasActiveFilters(filters)
  const isSearching = step === 'searching'

  /**
   * The downloaded file's classes, as the maintainer phrased them: colour for
   * what you HAVE, grey for what you are MISSING — that grey IS the answer to
   * "cuáles son los que faltan".
   *
   * THREE sources feed these tags, mirroring backend/config.py
   * `destination_for_quality` — a tag lights when any of them PROVES the
   * class, and stays grey while none can:
   *
   * 1. the arr's library: `item.quality` — contains `1080p` → 1080, contains
   *    `2160p` → 4K;
   * 2. THIS app's own grabs: every grab's `quality` says the same, and a grab
   *    whose `destination` is `path_3d` proves 3D — 3D has no quality token to
   *    read, so its destination IS the claim (the same way a path inside
   *    `path_3d` is the library's);
   * 3. the routing folders on disk: an entry whose name starts with this
   *    title's folder name AND that is a directory or a video file is a copy
   *    of it — in `path_4k` it proves 4K, in `path_3d` it proves 3D (a
   *    subtitle or `.nfo` there proves nothing at all).
   *
   * Never inferred from a missing value: an unknown/empty quality claims
   * NOTHING, an absent `path` finds NO copy (an empty prefix would match
   * every entry), a source that failed to load leaves a tag EXACTLY as the
   * sources that answered left it — never greyed DOWN — and an unconfigured
   * or unreadable folder can only fail to prove, never disprove. Grey is
   * "not proven", never "checked everywhere and absent": `hasFileNote` below
   * is where the UI says which case it is.
   */
  const libraryQuality = (item.quality ?? '').trim().toLowerCase()
  const grabs = grabsQuery.data ?? []
  const grabQualities = grabs.map((grab) => (grab.quality ?? '').toLowerCase())
  const copyPrefix = baseName(item.path ?? '')
  /**
   * An entry in a routing folder that IS a copy of this title.
   *
   * Counts only when it is a DIRECTORY (the nested layout:
   * `path_4k/<folder>/<file>`) or a file the backend CLASSIFIED as video
   * (the flat historical layout: `path_4k/<folder>….mkv`) — prefix match
   * first, because the copy keeps this title's folder name at the FRONT of
   * its name. A subtitle must never count: Dune's `path_4k` held only
   * `…[ES+EN].srt` (and `.nfo` files) and the 4K tag lit anyway.
   *
   * Classification is the BACKEND's (`_file_entry.is_video`, from
   * naming.MEDIA_EXTENSIONS — the repo's single definition of "video"):
   * a file CLASSIFIED as not-a-video refuses; an entry the payload never
   * classified (older build, test stub) is UNKNOWN and does not refuse —
   * real backend payloads always carry the boolean, so day to day the rule
   * is exact.
   *
   * Honest edge: a folder that exists but holds only junk still counts —
   * knowing otherwise would mean descending into every entry, i.e. a request
   * per copy per title.
   */
  const holdsCopy = (listing: FileItem[] | undefined): boolean =>
    copyPrefix !== '' &&
    !!listing?.some(
      (entry) => entry.name.startsWith(copyPrefix) && (entry.is_dir || entry.is_video !== false),
    )

  const hasFileTags = [
    {
      label: '1080',
      on:
        libraryQuality.includes('1080p') ||
        grabQualities.some((quality) => quality.includes('1080p')),
    },
    {
      label: '4K',
      on:
        libraryQuality.includes('2160p') ||
        grabQualities.some((quality) => quality.includes('2160p')) ||
        holdsCopy(listing4kQuery.data),
    },
    {
      label: '3D',
      on:
        inFolder(item.path ?? '', path3d) ||
        grabs.some((grab) => inFolder(grab.destination ?? '', path3d)) ||
        holdsCopy(listing3dQuery.data),
    },
  ]

  /**
   * The one thing the tags cannot say alone: WHY a source is not here. Grey
   * is "no source proved this class" (absent) — but a source that could not
   * be consulted (a failed read) or that does not exist (an unconfigured
   * folder) is UNKNOWN, and saying so out loud is what keeps "we could not
   * check" from reading as "we checked and there is nothing".
   */
  const hasFileNoteParts: string[] = []
  if (grabsQuery.isError) hasFileNoteParts.push('las descargas de la app no se pudieron leer')
  if (foldersUnreadable) hasFileNoteParts.push('la configuración de carpetas no se pudo leer')
  if (listing4kQuery.isError) hasFileNoteParts.push('la carpeta path_4k no se pudo leer')
  if (listing3dQuery.isError) hasFileNoteParts.push('la carpeta path_3d no se pudo leer')
  // Only a SUCCESSFUL settings read may call "" "unconfigured": while the
  // read is pending the value is unknown (not yet a fact), and a failed read
  // stays unknown too — neither may be reported as "sin configurar".
  if (foldersQuery.isSuccess && !path4k) hasFileNoteParts.push('path_4k sin configurar')
  if (foldersQuery.isSuccess && !path3d) hasFileNoteParts.push('path_3d sin configurar')
  const hasFileNote = hasFileNoteParts.length
    ? `Comprobación parcial: ${hasFileNoteParts.join(' · ')}`
    : ''

  function formatElapsed(s: number): string {
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}m ${s % 60}s`
  }

  /**
   * Leaving the search. The overlay IS a dialog: it ends through the caller's
   * `onClose`. The panel is not — there is nothing to close — so its exit is
   * literally "Nueva búsqueda": the search runs again for the same selection
   * instead of parking the operator back on the initial step to press 🔍
   * again. The cached results go with it, so a later re-open searches fresh
   * instead of restoring what this exit just discarded.
   */
  function dismiss() {
    if (inPanel) {
      panelResults.delete(`${item.source}:${item.type}:${item.id}`)
        void handleSearch()
      return
    }
    onClose?.()
  }

  /** What the exit button reads in each presentation. */
  const dismissLabel = inPanel ? 'Nueva búsqueda' : 'Cerrar'

  // What the status block has to say, if anything. On the panel a successful
  // grab does NOT leave the results: its ack rides above the list that stayed
  // on screen — and a plain results render (no ack) draws no box at all,
  // because `resultsNotice` is empty and `message` (search progress, step
  // feedback) is never rendered over a results view.
  const resultsNotice = step === 'results' ? notice : ''
  const showStatus =
    step === 'error' || step === 'done' || step === 'adding' || step === 'grabbing' || resultsNotice !== ''
  const statusClass =
    step === 'error' ? 'status-error' : step === 'done' || resultsNotice !== '' ? 'status-ok' : ''

  // One body, two presentations: the overlay wraps it in modal chrome, the
  // panel renders it as-is inside its container.
  const body = (
        <div className="scan-modal-body">
          {/* Item details — the overlay's own header repeats them; the panel's
              detail header already shows poster, title and metadata. */}
          {!inPanel && (
          <div className="calendar-modal-details">
            {item.remotePoster && (
              <img className="calendar-modal-poster" src={item.remotePoster} alt={item.title} />
            )}
            <div className="calendar-modal-info">
              {item.type === 'episode' ? (
                <>
                  <div className="calendar-modal-title">{item.series_title}</div>
                  <div className="calendar-modal-sub">
                    S{String(item.season_number ?? 0).padStart(2, '0')}E{String(item.episode_number ?? 0).padStart(2, '0')} — {item.title}
                  </div>
                </>
              ) : (
                <div className="calendar-modal-title">
                  {item.title} {item.year && <span className="wanted-year">({item.year})</span>}
                </div>
              )}
              {item.date && (
                <div className="calendar-modal-date">
                  {item.type === 'movie' ? '🗓️ Estreno' : '🗓️ Emisión'}: {item.date}
                </div>
              )}
            </div>
          </div>
          )}

          {/* Indexer selector. Overlay: only on the initial step, as always.
              Panel: persistent — changing it re-runs the search, the ONE
              automatic trigger left (🔍 starts the first one), so the
              operator can re-route while results are on screen. `disabled`
              never bites the overlay: its select only exists when no search
              is processing. */}
          {(inPanel || step === 'initial') && (
            <div className="calendar-indexer-select">
              <label className="calendar-indexer-label" htmlFor="release-indexer">Indexador:</label>
              <select
                id="release-indexer"
                className="calendar-indexer-dropdown"
                value={selectedIndexer}
                disabled={isProcessing}
                onChange={(e) => {
                  const next = e.target.value
                  setSelectedIndexer(next)
                  // PANEL ONLY: changing the indexer IS the trigger now.
                  if (inPanel && autoSearchable) void handleSearch(next)
                }}
              >
                <option value="all">Todos los indexadores</option>
                {indexers.map((idx) => (
                  <option key={idx.id} value={String(idx.id)}>{idx.name}</option>
                ))}
              </select>
              {indexersQuery.isError ? (
                <span className="calendar-indexer-error" role="alert">
                  ⚠️ No se pudo consultar {item.source}:{' '}
                  {indexersQuery.error instanceof Error
                    ? indexersQuery.error.message
                    : 'error desconocido'}
                  <button
                    type="button"
                    className="calendar-indexer-retry"
                    onClick={() => indexersQuery.refetch()}
                  >
                    Reintentar
                  </button>
                </span>
              ) : (
                indexers.length > 0 && (
                  <span className="calendar-indexer-count">{indexers.length} configurados</span>
                )
              )}
            </div>
          )}

          {/* Status message — rendered only when there IS one: error, done,
              adding, or the panel's post-grab ack above a list that never
              left. A plain results render must not draw an empty box. */}
          {showStatus && (
            <div className={`calendar-modal-status ${statusClass}`}>
              <div>{resultsNotice || message}</div>
            </div>
          )}

          {/* Step: Initial. The overlay keeps its 🔍 button and the body it
              has always rendered, byte for byte. The panel draws the SAME
              button again — selection never searches, the operator presses
              it — except where a different gate owns the next step: a title
              that already has a file meets the has-file block (its own
              "Buscar versiones") and an id 0 item needs ➕ first, so neither
              gets a 🔍 of its own. `step === 'initial'` IS "no results yet
              for this item": a re-open with cached results mounts on
              'results' and never lands on this step. */}
          {step === 'initial' && (
            item.has_file ? (
              /* What IS on disk (the real name, its languages), what you HAVE
                 vs what you are MISSING (the tags), and the way out of the
                 dead end: a title that already has a file can still be
                 searched — the entry point into F-01's upgrade. A surface
                 without this data (the calendar's cards) degrades to an
                 explicit "not available" and grey tags: it never invents a
                 name and never claims a class the arr did not report. */
              <div className="has-file-block">
                <span className="has-file-label">Fichero descargado</span>
                {item.file_name ? (
                  <code className="has-file-name">{item.file_name}</code>
                ) : (
                  <span className="has-file-name has-file-missing">
                    Nombre no disponible en esta vista
                  </span>
                )}
                {/* Only when the file's languages exist: an empty list renders
                    nothing — no dash, no "sin idioma" invention. */}
                {(item.languages?.length ?? 0) > 0 && (
                  <span className="has-file-langs">{(item.languages ?? []).join(', ')}</span>
                )}
                <div className="has-file-tags">
                  {hasFileTags.map((tag) => (
                    <span
                      key={tag.label}
                      className={`has-file-tag ${tag.on ? 'is-on' : 'is-off'}`}
                    >
                      {tag.label}
                    </span>
                  ))}
                </div>
                {/* Unknown is not absent: this line exists only when some
                    source could not be consulted (or does not exist), so a
                    grey tag is never mistaken for a check that came back
                    empty. Nothing to explain → nothing rendered. */}
                {hasFileNote && <span className="has-file-note">{hasFileNote}</span>}
                <button
                  type="button"
                  className="action-btn search-all"
                  onClick={() => void handleSearch()}
                  disabled={isProcessing}
                >
                  Buscar versiones
                </button>
              </div>
            ) : (
              <div className="calendar-modal-actions">
                {/* 🔍 for the overlay (always, as ever) and for the panel's
                    autoSearchable population — the gate that leaves id 0 to
                    ➕ and a has-file title to its own block. */}
                {(!inPanel || autoSearchable) && (
                  <button
                    className="action-btn search-all"
                    onClick={() => {
                      if (inPanel) {
                        // Once per mount: a same-tick double click must not
                        // fire two 240-second searches. The panel never
                        // returns to 'initial', so this can never swallow a
                        // legitimate second press.
                        if (autoSearched.current) return
                        autoSearched.current = true
                      }
                      void handleSearch()
                    }}
                    disabled={isProcessing}
                  >
                    🔍 Buscar Releases
                  </button>
                )}
                {item.id === 0 && (
                  <button
                    className="action-btn scan-folder-btn"
                    onClick={handleAddAndSearch}
                    disabled={isProcessing}
                  >
                    ➕ Agregar a Biblioteca y Buscar
                  </button>
                )}
              </div>
            )
          )}

          {/* Step: Searching — show progress */}
          {isSearching && (
            <div className="calendar-modal-progress">
              <div className="progress-spinner"></div>
              <div className="progress-text">
                <span>{message}</span>
                <span className="progress-elapsed">{formatElapsed(elapsed)}</span>
              </div>
              <div className="progress-bar-container">
                <div
                  className="progress-bar"
                  style={{ width: `${Math.max(0, ((SEARCH_TIMEOUT - elapsed) / SEARCH_TIMEOUT) * 100)}%` }}
                />
              </div>
              <div className="progress-hint">
                {elapsed < 30
                  ? 'Los indexadores pueden tardar. Paciencia...'
                  : elapsed < 120
                    ? 'Buscando en indexadores lentos (aMuleTorrent puede tardar)...'
                    : elapsed < 200
                      ? 'Algunos indexadores son muy lentos. Esperando...'
                      : 'Casi se acaba el tiempo...'}
              </div>
            </div>
          )}

          {/* Step: Results — show grouped by indexer */}
          {step === 'results' && (
            <div className="calendar-releases">
              <div className="calendar-releases-header">
                <span className="release-count">
                  {filtersActive
                    ? `${visibleReleases.length} de ${releases.length} releases`
                    : `${releases.length} releases encontrados`}
                </span>
                <div className="calendar-releases-actions">
                  <button className="action-btn" onClick={() => void handleSearch()} disabled={isProcessing}>
                    🔄 Refrescar
                  </button>
                </div>
              </div>

              <div className="release-filters">
                <input
                  type="text"
                  className="release-filter-text"
                  placeholder="Filtrar por título..."
                  value={filters.text}
                  onChange={(e) => setFilters((f) => ({ ...f, text: e.target.value }))}
                />

                <label className="release-filter-seeders">
                  Seeders mín.
                  <input
                    type="number"
                    min={0}
                    value={filters.minSeeders || ''}
                    placeholder="0"
                    onChange={(e) =>
                      setFilters((f) => ({
                        ...f,
                        minSeeders: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                  />
                </label>

                {qualityOptions.length > 0 && (
                  <div className="release-filter-group">
                    <span className="release-filter-label">Calidad</span>
                    <div className="release-filter-chips">
                      {qualityOptions.map((quality) => (
                        <button
                          key={quality}
                          type="button"
                          className={`release-chip ${filters.qualities.has(quality) ? 'active' : ''}`}
                          onClick={() =>
                            setFilters((f) => ({ ...f, qualities: toggleInSet(f.qualities, quality) }))
                          }
                        >
                          {quality}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {languageOptions.length > 0 && (
                  <div className="release-filter-group">
                    <span className="release-filter-label">Idioma</span>
                    <div className="release-filter-chips">
                      {languageOptions.map((language) => (
                        <button
                          key={language}
                          type="button"
                          className={`release-chip ${filters.languages.has(language) ? 'active' : ''}`}
                          onClick={() =>
                            setFilters((f) => ({ ...f, languages: toggleInSet(f.languages, language) }))
                          }
                        >
                          {language}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {filtersActive && (
                  <button
                    type="button"
                    className="release-filter-clear"
                    onClick={() => setFilters(NO_RELEASE_FILTERS)}
                  >
                    ✕ Limpiar filtros
                  </button>
                )}
              </div>

              {visibleReleases.length === 0 ? (
                <div className="wanted-empty">Ningún release coincide con los filtros</div>
              ) : (
                Array.from(groupByIndexer(visibleReleases).entries()).map(([indexer, items]) => (
                <div key={indexer} className="calendar-indexer-group">
                  <div className="calendar-indexer-name">🌐 {indexer}</div>
                  <div className="calendar-releases-list">
                    {items.map((r) => (
                      <div
                        key={r.guid}
                        className="calendar-release"
                      >
                        <div className="release-content">
                          {/* The file selector's row: the file's name alone on
                              its line, the four facts that pick a file beneath
                              it. The 3D mark rides the facts line — it changes
                              where the row routes, and that is what the line
                              describes. */}
                          <div className="release-title">{r.title}</div>
                          <div className="release-meta">
                            {releaseMetaParts(r).map((part, i) => (
                              <Fragment key={part.className}>
                                {i > 0 && (
                                  <span className="release-sep" aria-hidden="true">·</span>
                                )}
                                <span className={part.className}>{part.text}</span>
                              </Fragment>
                            ))}
                            <button
                              type="button"
                              className={`release-3d ${isThreeD(r) ? 'active' : ''}`}
                              aria-pressed={isThreeD(r)}
                              aria-label={
                                isThreeD(r)
                                  ? `Quitar la marca 3D de ${r.title}`
                                  : `Marcar ${r.title} como 3D`
                              }
                              onClick={() => toggleThreeD(r.guid)}
                            >
                              3D
                            </button>
                          </div>
                          <div className="release-dest">
                            <button
                              type="button"
                              className={`release-dest-btn ${destinationFor(r) === LIBRARY ? 'suggest' : ''}`}
                              onClick={() => void handleGrab(r.guid, 'library')}
                              disabled={isProcessing}
                              title={LIBRARY}
                            >
                              → Biblioteca
                            </button>
                            <button
                              type="button"
                              className={`release-dest-btn ${path4k && destinationFor(r) === path4k ? 'suggest' : ''}`}
                              onClick={() => void handleGrab(r.guid, '4k')}
                              disabled={isProcessing || !path4k}
                              title={path4k || '4K sin configurar'}
                            >
                              → 4K
                            </button>
                            <button
                              type="button"
                              className={`release-dest-btn ${path3d && destinationFor(r) === path3d ? 'suggest' : ''}`}
                              onClick={() => void handleGrab(r.guid, '3d')}
                              disabled={isProcessing || !path3d}
                              title={path3d || '3D sin configurar'}
                            >
                              → 3D
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                ))
              )}
            </div>
          )}

          {/* Step: Done */}
          {step === 'done' && (
            <div className="calendar-modal-actions">
              <button className="action-btn search-all" onClick={dismiss}>
                {dismissLabel}
              </button>
            </div>
          )}

          {/* Step: Error — without this the user is stuck after a failed grab */}
          {step === 'error' && (
            <div className="calendar-modal-actions">
              {releases.length > 0 && (
                <button
                  className="action-btn"
                  onClick={() => {
                    setMessage('')
                    setStep('results')
                  }}
                >
                  ← Volver a los resultados
                </button>
              )}
              <button className="action-btn" onClick={dismiss}>
                {dismissLabel}
              </button>
            </div>
          )}
        </div>
  )

  if (inPanel) {
    // Fills its container: no backdrop, no modal chrome, no positioning.
    return <div className="release-inline">{body}</div>
  }

  return (
    <div className="scan-modal-backdrop" onClick={handleBackdropClick}>
      <div className="scan-modal scan-modal-wide" ref={modalRef}>
        <div className="scan-modal-header">
          <div className="scan-selected-info">
            <span className="scan-selected-type">{item.type === 'movie' ? '🎬' : '📺'}</span>
            <strong>{item.series_title || item.title}</strong>
          </div>
          <button className="scan-modal-close" onClick={() => onClose?.()}>×</button>
        </div>
        {body}
      </div>
    </div>
  )
}
