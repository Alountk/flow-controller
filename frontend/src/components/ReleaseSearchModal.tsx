import { Fragment, useState, useRef, useCallback, useEffect } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  addCalendarItem,
  fetchCalendarReleases,
  fetchCalendarDestinations,
  grabCalendarRelease,
  grabCalendarReleaseBatch,
  type Release,
} from '../api/calendar'
import { apiFetch } from '../api/auth'
import { areAllVisibleSelected, toggleVisibleSelection } from '../utils/selection'
import { looksThreeD } from '../utils/threeD'
import {
  NO_RELEASE_FILTERS,
  collectLanguages,
  collectQualities,
  filterReleases,
  hasActiveFilters,
  releaseKey,
  toggleInSet,
  type ReleaseFilters,
} from '../utils/releaseFilters'
import './CalendarModal.css'

interface Indexer {
  id: number
  name: string
  implementation: string
  enableSearch: boolean
}

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
}

type ModalStep = 'initial' | 'searching' | 'adding' | 'results' | 'grabbing' | 'done' | 'error'

const SEARCH_TIMEOUT = 240 // seconds — must match backend REQUEST_TIMEOUT * 48

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

/**
 * The panel's results, per ITEM, across the tab switches that unmount it.
 *
 * The Releases view is conditionally rendered, so leaving it used to destroy
 * everything — and with auto-search that means re-opening the tab would re-run
 * a search that can take 240 seconds and already returned. Keyed by
 * source/type/id (never by visit): a different title is a different search,
 * the same title is the same results. Session-scoped module state: overlay
 * presentations never read or write it.
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

/** Rows that would all land in the same folder, and must travel as one call. */
interface RoutingGroup {
  quality: string
  is3d: boolean
  guids: string[]
}

export function ReleaseSearchModal({
  item,
  onClose,
  presentation = 'overlay',
}: ReleaseSearchModalProps) {
  const inPanel = presentation === 'panel'
  // The population the removed 🔍 button served: a title that still needs a
  // file, and one already inside the library (id 0 must be ADDED first — its
  // ➕ button's job). Both panel triggers share this gate, so a title that
  // already has its file never auto-searches: it meets the has-file block,
  // whose "Buscar versiones" button searches on demand instead.
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
  const [selectedIndexer, setSelectedIndexer] = useState<string>(restored?.indexer ?? 'all')
  const [releases, setReleases] = useState<Release[]>(restored?.releases ?? [])
  const [selectedGuids, setSelectedGuids] = useState<Set<string>>(new Set())
  const [destinations, setDestinations] = useState<string[]>([])
  const [destination, setDestination] = useState('')
  const [filters, setFilters] = useState<ReleaseFilters>(NO_RELEASE_FILTERS)
  const [grabErrors, setGrabErrors] = useState<{ guid: string; detail: string }[]>([])
  // Per-row corrections to the 3D suggestion. An absent guid means "no human
  // has spoken, trust the title"; present means "this is what I said".
  const [threeDOverrides, setThreeDOverrides] = useState<Record<string, boolean>>(
    restored?.threeDOverrides ?? {},
  )
  const [elapsed, setElapsed] = useState(0)
  const modalRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Mount-once guard for the panel's auto-search: React's development
  // double-invoke of effects must not fire two 240-second searches.
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

  // Fetch destination folders on mount. A failed load is not fatal: the combo
  // keeps its built-in library default, so searching and grabbing still work.
  useEffect(() => {
    fetchCalendarDestinations(item.source)
      .then((data) => setDestinations(data.folders))
      .catch(() => {})
  }, [item.source])

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

  // PANEL ONLY: the search starts itself. It replaces the 🔍 Buscar Releases
  // button the panel no longer draws, under exactly the conditions that
  // button had: it never fired for a title that already has its file (that
  // one meets the has-file block and searches from its own "Buscar versiones"
  // button), nor for an id 0 item — that one must be ADDED to the library
  // first, which is its ➕ button's job. A re-open with cached results never
  // reaches this effect: it mounts on 'results'.
  useEffect(() => {
    if (!inPanel || autoSearched.current) return
    // A re-open restores straight onto 'results' (see panelResults): the
    // search that already returned must not run again just because the view
    // was rebuilt around it.
    if (step !== 'initial') return
    if (!autoSearchable) return
    autoSearched.current = true
    void handleSearch()
    // Mount-only by design (the panel never returns to 'initial' on its own),
    // so the deps stay empty; this repo does not run react-hooks rules.
  }, [])

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

  /**
   * `choice` is the indexer the search runs under. It is a real parameter,
   * not state, because the panel's auto-search on an indexer change fires in
   * the same tick as setSelectedIndexer — reading state there would search
   * under the PREVIOUS choice. The overlay passes nothing (its button always
   * searches what the select already shows).
   */
  async function handleSearch(choice: string = selectedIndexer) {
    setStep('searching')
    setGrabErrors([])
    const idxName = choice !== 'all' ? (indexers.find(i => String(i.id) === choice)?.name || '') : ''
    setMessage(`Buscando releases${idxName ? ` en ${idxName}` : ' en todos los indexadores'}...`)
    try {
      const result = await fetchCalendarReleases(item.source, item.type, item.id)
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

  async function handleGrab(guid: string) {
    setStep('grabbing')
    setGrabErrors([])
    setMessage('Descargando...')
    const release = releases.find(r => r.guid === guid)
    // An empty `destination` means the arr's library and must stay absent from
    // the request, exactly as it was before the combo existed.
    const result = await grabCalendarRelease(
      item.source,
      guid,
      release?.indexerId || 0,
      item.type === 'movie' ? item.id : 0,
      item.type === 'episode' ? item.id : 0,
      destination || undefined,
      release?.quality || undefined,
      release ? isThreeD(release) : undefined,
    )
    if (result.ok) {
      setStep('done')
      setMessage('Descarga iniciada. Revisa la cola de descargas.')
    } else {
      setStep('error')
      setMessage(result.detail)
    }
  }

  function toggleGuid(guid: string) {
    setSelectedGuids(prev => {
      const next = new Set(prev)
      if (next.has(guid)) {
        next.delete(guid)
      } else {
        next.add(guid)
      }
      return next
    })
  }

  function toggleAll() {
    // Only touches what the filter is showing: acting on hidden rows would
    // download releases the user never looked at.
    setSelectedGuids((prev) => toggleVisibleSelection(prev, visibleReleases, releaseKey))
  }

  /**
   * One call per *routing class*, not one call per batch.
   *
   * `grab-batch` carries a single `quality` and a single `is3d`, so a selection
   * holding two classes has no truthful value for one call — and naming either
   * would send the other to the wrong folder. Sending neither would send a 3D
   * release down the same route as any other: the arr may import it and replace
   * what should have been kept, which is precisely the coexistence failure this
   * feature exists to avoid.
   *
   * When a destination was chosen by hand it already wins server-side, so the
   * split buys nothing and one call is enough.
   */
  function splitByRouting(guids: string[]): RoutingGroup[] {
    if (destination) return [{ quality: '', is3d: false, guids }]
    const groups = new Map<string, RoutingGroup>()
    for (const guid of guids) {
      const release = releases.find((r) => r.guid === guid)
      const is3d = release ? isThreeD(release) : false
      const quality = release?.quality ?? ''
      const key = `${is3d ? '3d' : ''}|${quality}`
      const bucket = groups.get(key)
      if (bucket) bucket.guids.push(guid)
      else groups.set(key, { quality, is3d, guids: [guid] })
    }
    return [...groups.values()]
  }

  async function handleGrabBatch() {
    if (selectedGuids.size === 0) return
    setStep('grabbing')
    setGrabErrors([])
    setMessage(`Descargando ${selectedGuids.size} releases...`)

    let ok = true
    let firstDetail = ''
    let downloaded = 0
    const errors: { guid: string; detail: string }[] = []
    const details: string[] = []

    for (const group of splitByRouting(Array.from(selectedGuids))) {
      const indexerIds = group.guids.map(g => releases.find(r => r.guid === g)?.indexerId || 0)
      const result = await grabCalendarReleaseBatch(
        item.source,
        group.guids,
        indexerIds,
        item.type === 'movie' ? item.id : 0,
        item.type === 'episode' ? item.id : 0,
        destination || undefined,
        group.quality || undefined,
        group.is3d || undefined,
      )
      errors.push(...(result.errors ?? []))
      downloaded += result.downloaded?.length ?? 0
      details.push(result.detail)
      if (!result.ok) {
        ok = false
        if (!firstDetail) firstDetail = result.detail
      }
    }

    setGrabErrors(errors)
    if (ok) {
      setStep('done')
      // One group means one call, so its own wording still reaches the user
      // unchanged; only a split batch needs a summary of its own.
      setMessage(details.length === 1 ? details[0] : `${downloaded} descargados`)
      setSelectedGuids(new Set())
    } else {
      setStep('error')
      setMessage(firstDetail)
    }
  }

  const isProcessing = step === 'searching' || step === 'adding' || step === 'grabbing'

  // Options come from the FULL result set, so they do not vanish as you filter.
  const qualityOptions = collectQualities(releases)
  const languageOptions = collectLanguages(releases)
  const visibleReleases = filterReleases(releases, filters)
  const filtersActive = hasActiveFilters(filters)
  const allVisibleSelected = areAllVisibleSelected(selectedGuids, visibleReleases, releaseKey)
  const isSearching = step === 'searching'

  /**
   * The downloaded file's classes, as the maintainer phrased them: colour for
   * what you HAVE, grey for what you are MISSING — that grey IS the answer to
   * "cuáles son los que faltan".
   *
   * Rules, one per tag, mirroring backend/config.py `destination_for_quality`:
   * `1080` ← the quality contains `1080p`, `4K` ← it contains `2160p`, and
   * `3D` is not a quality but a PLACE — the title's `path` inside `path_3d`,
   * the same membership PR #113 established for Series. An unknown/empty
   * quality claims NOTHING (both resolution tags stay grey — no guessing), and
   * an unconfigured or unreadable `path_3d` can never light 3D either.
   */
  const fileQuality = (item.quality ?? '').trim().toLowerCase()
  const hasFileTags = [
    { label: '1080', on: fileQuality.includes('1080p') },
    { label: '4K', on: fileQuality.includes('2160p') },
    { label: '3D', on: inFolder(item.path ?? '', path3d) },
  ]

  function formatElapsed(s: number): string {
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}m ${s % 60}s`
  }

  /**
   * Leaving the search. The overlay IS a dialog: it ends through the caller's
   * `onClose`. The panel is not — there is nothing to close — so its exit is
   * literally "Nueva búsqueda": the search runs again for the same selection
   * instead of parking the operator on an initial step whose button no longer
   * exists. The cached results go with it, so a later re-open searches fresh
   * instead of restoring what this exit just discarded.
   */
  function dismiss() {
    if (inPanel) {
      panelResults.delete(`${item.source}:${item.type}:${item.id}`)
      setSelectedGuids(new Set())
      setGrabErrors([])
      void handleSearch()
      return
    }
    onClose?.()
  }

  /** What the exit button reads in each presentation. */
  const dismissLabel = inPanel ? 'Nueva búsqueda' : 'Cerrar'

  /**
   * The readout of `Acción principal` — a READOUT, never a second control.
   *
   * Every rule below mirrors backend/config.py `destination_for_quality`,
   * which is the code that actually routes the grab: 3D outranks the
   * resolution, only a `2160p` suffix is 4K, an unconfigured folder falls
   * through (to the library), and a folder chosen by hand would beat all of
   * it — which is why the combo is labelled an override.
   */
  function routingClass(r: Release): string {
    if (isThreeD(r)) return '3D'
    const quality = r.quality.trim().toLowerCase()
    if (quality.endsWith('2160p')) return '4K'
    // Empty quality is unknown, never "1080": the class of a fact the arr
    // could not tell us is not a fact.
    return quality ? '1080 o menor' : 'calidad desconocida'
  }

  /** Where this row lands when nobody picked a folder by hand. */
  function destinationFor(r: Release): string {
    if (foldersUnreadable) return 'la que decida el backend (configuración ilegible)'
    if (isThreeD(r) && path3d) return path3d
    if (r.quality.trim().toLowerCase().endsWith('2160p') && path4k) return path4k
    return LIBRARY
  }

  /** One rule line: the folder when it exists, the key's own honest state
   *  when it does not — "not configured" and "could not be read" are
   *  different facts and must not read the same. */
  function ruleFolder(key: 'path_4k' | 'path_3d', value: string): string {
    if (foldersUnreadable) return `${key} — no se pudo leer la configuración`
    return value || `${key} sin configurar`
  }

  // The selection, grouped by the destination it resolves to: that grouping
  // is the answer to "where does what I picked go". A manual destination
  // replaces every row's own routing — one group, one folder, as the grab
  // itself will behave.
  const selectedRows = releases.filter((r) => selectedGuids.has(r.guid))
  const selectedRouting = new Map<string, Set<string>>()
  for (const r of selectedRows) {
    const dest = destination || destinationFor(r)
    const classes = selectedRouting.get(dest) ?? new Set<string>()
    classes.add(routingClass(r))
    selectedRouting.set(dest, classes)
  }

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
              Panel: persistent — it IS the search control now that the
              button is gone, so the operator can re-route the search while
              results are on screen. `disabled` never bites the overlay: its
              select only exists when no search is processing. */}
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

          {/* Status message */}
          {(step === 'error' || step === 'done' || step === 'adding') && (
            <div className={`calendar-modal-status ${
              step === 'error' ? 'status-error' : step === 'done' ? 'status-ok' : ''
            }`}>
              <div>{message}</div>
              {grabErrors.length > 0 && (
                <ul className="calendar-error-list">
                  {grabErrors.slice(0, 5).map((err) => (
                    <li key={err.guid}>
                      <span className="calendar-error-detail">{err.detail}</span>
                    </li>
                  ))}
                  {grabErrors.length > 5 && (
                    <li className="calendar-error-more">
                      …y {grabErrors.length - 5} más
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}

          {/* Step: Initial. The overlay keeps its 🔍 button and the body it
              has always rendered. The panel has no button to render — its
              search fires by itself — so the block appears there only when
              something still has something to say: the downloaded file's own
              facts (PR C), or the add-first button an id 0 item needs. */}
          {step === 'initial' && (item.has_file || item.id === 0 || !inPanel) && (
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
                {!inPanel && (
                  <button
                    className="action-btn search-all"
                    onClick={() => void handleSearch()}
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
                <label className="release-checkbox-all">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    disabled={visibleReleases.length === 0}
                  />
                  <span>
                    {filtersActive
                      ? `${visibleReleases.length} de ${releases.length} releases`
                      : `${releases.length} releases encontrados`}
                  </span>
                </label>
                <div className="calendar-releases-actions">
                  {selectedGuids.size > 0 && (
                    <button className="action-btn grab-selected" onClick={handleGrabBatch} disabled={isProcessing}>
                      ⬇️ Descargar ({selectedGuids.size})
                    </button>
                  )}
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
                        className={`calendar-release ${selectedGuids.has(r.guid) ? 'selected' : ''}`}
                      >
                        <label className="release-checkbox">
                          <input
                            type="checkbox"
                            checked={selectedGuids.has(r.guid)}
                            onChange={() => toggleGuid(r.guid)}
                          />
                        </label>
                        <div className="release-content" onClick={() => handleGrab(r.guid)}>
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
                              onClick={(e) => {
                                // The row's own click grabs the release; this
                                // button only changes where it would go.
                                e.stopPropagation()
                                toggleThreeD(r.guid)
                              }}
                            >
                              3D
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                ))
              )}

              {/* Acción principal — the routing, visible. A readout of what
                  the selection resolves to, the three rules behind it, and
                  the destination combo inside the block it overrides: a
                  folder chosen by hand beats the derived routing, and the
                  label says so instead of hiding it. */}
              <div className="release-action">
                <h4 className="release-action-title">Acción principal</h4>

                {selectedRows.length > 0 && (
                  <>
                    <p className="release-action-sub">Destino de la selección:</p>
                    <ul className="release-action-selected">
                      {[...selectedRouting].map(([dest, classes]) => (
                        <li key={dest}>
                          <strong>{[...classes].join(' · ')}</strong> → {dest}
                          {destination && (
                            <span className="release-action-note">
                              {' '}
                              — elegido a mano: manda sobre el enrutado
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                <p className="release-action-sub">Reglas de enrutado (si no eliges carpeta a mano):</p>
                <ul className="release-action-rules">
                  <li>1080 o menor → biblioteca (la del arr)</li>
                  <li>4K → {ruleFolder('path_4k', path4k)}</li>
                  <li>3D → {ruleFolder('path_3d', path3d)}</li>
                </ul>

                {/* The chosen folder applies to the marked rows (per-row and
                    batch grabs). The library default sends no destination at
                    all — absent is what "library" means end to end. */}
                <div className="calendar-indexer-select">
                  <label className="calendar-indexer-label" htmlFor="release-destination">
                    Destino (anulación manual):
                  </label>
                  <select
                    id="release-destination"
                    className="calendar-indexer-dropdown"
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                  >
                    <option value="">{LIBRARY}</option>
                    {destinations.map((folder) => (
                      <option key={folder} value={folder}>{folder}</option>
                    ))}
                  </select>
                </div>
              </div>
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

// Backward-compatible alias
export const CalendarModal = ReleaseSearchModal
