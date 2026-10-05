import { Fragment, useId, useState } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Calendar } from './Calendar'
import { MediaPane, type MediaDetail, type MediaSelection } from './MediaPane'
import { ReleaseSearchModal, type ReleaseSearchItem } from './ReleaseSearchModal'
import { apiFetch } from '../api/auth'
import { browsePath } from '../api/files'
import { fetchSeriesEpisodes } from '../api/wanted'
import { episodeTagKey } from '../utils/episodeTag'
import { formatGrabMark } from '../utils/grabMark'
import type { AllSeries, BrowseResponse, CalendarItem, PaginatedResponse, SeriesEpisode } from '../types'
import './Sections.css'

/**
 * Series — master–detail (F-08).
 *
 * PR 6 of the plan: the detail panel's tabs all carry real data. Releases
 * (PR 5) holds the release search inline; Episodios lists the series'
 * episodes through GET /api/wanted/series/{id}/episodes; Archivos lists the
 * selected row's folder read-only through GET /api/files/browse; Historial
 * reads the row's own `grabbed_at`/`grabbed_destination`. The sub-views are
 * unchanged: Biblioteca and Faltantes render MediaPane, Estrenos the
 * calendar, Calidad the folder-derived class list. The twin of Películas:
 * same model, different words.
 */

type SubView = 'biblioteca' | 'faltantes' | 'estrenos' | 'calidad'

interface SubViewDef {
  id: SubView
  label: string
}

const SUB_VIEWS: SubViewDef[] = [
  { id: 'biblioteca', label: 'Biblioteca' },
  // 'Faltantes' is not a tab any more: it lives in the filter buttons beside
  // the name search (PR #150). The view itself is unchanged — only the
  // control that reaches it. `SUB_VIEWS[0]` stays biblioteca.
  { id: 'estrenos', label: 'Estrenos' },
  { id: 'calidad', label: 'Calidad' },
]

const DETAIL_TABS = ['Episodios', 'Releases', 'Archivos', 'Historial']

const NOTES: { pr: string; text: string }[] = [
  { pr: 'PR 1 ✅', text: 'techo: navegación, rutas y la envoltura maestro–detalle.' },
  { pr: 'PR 2 ✅', text: 'Biblioteca y Faltantes muestran las listas reales, extraídas de la sección Faltantes; la selección rellena el panel de detalle.' },
  { pr: 'PR 3 ✅', text: 'Estrenos muestra el calendario: solo episodios aquí, solo películas en Películas.' },
  { pr: 'PR 4 ✅', text: 'Calidad agrupa por clase: aquí la clase sale de la carpeta en la que vive cada serie (Sonarr no da calidad en su lista); en Películas sale de la calidad del archivo de Radarr.' },
  { pr: 'PR 5 ✅', text: 'buscar releases vive en la pestaña Releases del panel y las filas adoptan la forma del prototipo (mini póster, estado, calidad y ruta); desde la lista y desde el calendario de Estrenos ya no se abre ningún modal.' },
  { pr: 'PR 6 ✅', text: 'Episodios, Archivos e Historial dejan de ser marcadores: los episodios salen de /api/wanted/series/{id}/episodes, la ruta de la selección se lista con browsePath (solo lectura) y Historial enseña el grabbed_at/grabbed_destination de la propia fila.' },
  { pr: 'PR 7 (este) ✅', text: 'los menús Faltantes y Calendario se retiran del lateral y sus tests migran a las secciones.' },
]

const PANEL_EMPTY = 'Selecciona un elemento de la lista para ver su detalle.'
const PANEL_NOTE =
  'La búsqueda de releases vive en la pestaña Releases de este panel (PR 5): las filas del calendario de Estrenos seleccionan aquí como cualquier otra. Las pestañas Episodios, Archivos e Historial se llenan con datos reales desde el PR 6.'

/* ── Calidad (PR 4) ─────────────────────────────────────────────────────────
 * The same four classes as in Películas, derived from a different fact: a
 * series' class is the folder it lives in, which is what F-01's routing
 * produces. Sonarr's series list has NO quality and this view never pretends
 * otherwise — the note on screen says so.
 */

type QualityClass = '4K' | '3D' | 'en biblioteca' | 'desconocida'

const QUALITY_CLASSES: QualityClass[] = ['4K', '3D', 'en biblioteca', 'desconocida']

const CALIDAD_COLUMNS = ['Título', 'Año', 'Clase', 'Calidad', 'Ruta', 'Enrutado']

interface RoutingFolders {
  path4k: string
  path3d: string
}

/** True when `path` is `folder` or lives under it. An unconfigured folder ("")
 *  matches nothing: empty means "not configured", never "everything". */
function inFolder(path: string, folder: string): boolean {
  if (!path || !folder) return false
  const root = folder.endsWith('/') ? folder.slice(0, -1) : folder
  return path === root || path.startsWith(`${root}/`)
}

/** Which routing folders hold the series, named by their settings keys; the
 *  cell renders "—" when it lives in neither. */
function routedIn(path: string, folders: RoutingFolders): string[] {
  const routed: string[] = []
  if (inFolder(path, folders.path4k)) routed.push('path_4k')
  if (inFolder(path, folders.path3d)) routed.push('path_3d')
  return routed
}

/** The class of a series = where it lives: path_4k → 4K, path_3d → 3D,
 *  anything else (including a missing path) → en biblioteca. No quality is
 *  consulted, because Sonarr's list does not carry one. */
function seriesClass(series: AllSeries, folders: RoutingFolders): QualityClass {
  if (inFolder(series.path, folders.path4k)) return '4K'
  if (inFolder(series.path, folders.path3d)) return '3D'
  return 'en biblioteca'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'error desconocido'
}

/** The two routing folders, from GET /api/settings — the same document
 *  backend/config.py rebuilds PATH_4K/PATH_3D from. Absent keys and "" mean
 *  the same thing: not configured. */
async function fetchRoutingFolders(): Promise<RoutingFolders> {
  const res = await apiFetch('/api/settings', {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { paths?: { path_4k?: string; path_3d?: string } }
  return {
    path4k: (body.paths?.path_4k ?? '').trim(),
    path3d: (body.paths?.path_3d ?? '').trim(),
  }
}

/** The whole catalogue in one request (page_size=0 is the endpoint's own
 *  "do not slice" signal), with every failure carried on the body: a failed
 *  fetch must never render as "nothing is in any class". */
async function fetchCalidadSeries(): Promise<PaginatedResponse<AllSeries>> {
  const res = await apiFetch('/api/wanted/series/all?page=1&page_size=0', {})
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string }
    return {
      items: [],
      total: 0,
      error: typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}`,
    }
  }
  const body = (await res.json()) as PaginatedResponse<AllSeries>
  return { ...body, items: body.items ?? [] }
}

function calidadSeriesDetail(series: AllSeries, folders: RoutingFolders): MediaDetail {
  const routed = routedIn(series.path, folders)
  const meta: { label: string; value: string }[] = []
  if (series.year != null) meta.push({ label: 'Año', value: String(series.year) })
  meta.push({ label: 'Clase', value: seriesClass(series, folders) })
  meta.push({ label: 'Ruta', value: series.path || '—' })
  meta.push({ label: 'Enrutado', value: routed.join(' · ') || '—' })
  return {
    title: series.title,
    poster: series.remotePoster || undefined,
    meta,
    grab: formatGrabMark(series.grabbed_at, series.grabbed_destination) ?? undefined,
  }
}

/** What a Calidad row hands the panel's Releases tab: the same item the
 *  release-search modal would open for this series. */
function calidadSeriesRelease(series: AllSeries): ReleaseSearchItem {
  return {
    type: 'episode',
    id: series.id,
    title: series.title,
    series_title: series.title,
    year: series.year,
    source: 'sonarr',
    remotePoster: series.remotePoster,
    has_file: series.has_file,
    // Typed episode (what Sonarr grabs) but keyed as the SERIES it is: the
    // grabs history asked for `episode_id=<seriesId>` would return another
    // show's episode with the same number and light a class we do not have.
    idKind: 'series',
  }
}

/* ── Estrenos (the calendar selects, PR 5's last gap) ───────────────────────
 * A CalendarItem carries only its own fields: the episode's air date, the
 * series year Sonarr reported, the has_file flag and the grab mark. Nothing
 * else — no path, no series id (Sonarr's calendar payload omits it) — so
 * nothing else is built here.
 */

function estrenoDetail(item: CalendarItem): MediaDetail {
  const s = String(item.season_number ?? 0).padStart(2, '0')
  const e = String(item.episode_number ?? 0).padStart(2, '0')
  const meta: { label: string; value: string }[] = [
    { label: 'Episodio', value: `S${s}E${e} · ${item.title}` },
  ]
  // The date Sonarr's calendar put the card on is the episode's air date —
  // the only date the item knows.
  if (item.date) meta.push({ label: 'Emitido', value: item.date })
  // Straight from the flag the card's own ✓ badge reads: the calendar has no
  // path_exists, so a folder-based claim would be a guess.
  meta.push({ label: 'Estado', value: item.has_file ? 'Con archivo' : 'Sin archivo' })
  return {
    title: item.series_title || item.title,
    poster: item.remotePoster || undefined,
    meta,
    grab: formatGrabMark(item.grabbed_at, item.grabbed_destination) ?? undefined,
  }
}

/** What a calendar card hands the panel's Releases tab: exactly the item the
 *  overlay modal used to open for it — every field read off the item itself. */
function estrenoRelease(item: CalendarItem): ReleaseSearchItem {
  return {
    type: item.type,
    id: item.id,
    title: item.title,
    source: item.source,
    date: item.date,
    year: item.year,
    series_title: item.series_title,
    season_number: item.season_number,
    episode_number: item.episode_number,
    has_file: item.has_file,
    remotePoster: item.remotePoster,
    // A calendar item's id is its own kind — the card says which one, and
    // the grabs history must be asked under exactly that key.
    idKind: item.type,
  }
}

/* ── An episode marked in the Episodios tab ──────────────────────────────────
 * The twin of the two builders above, fed by ONE row of the episodes table
 * instead of a calendar card. `seriesTitle` travels as an argument because a
 * SeriesEpisode payload carries no series title of its own — it is read off
 * the selected series' detail, the row the episodes belong to.
 */

function episodeDetail(ep: SeriesEpisode, seriesTitle: string): MediaDetail {
  const meta: { label: string; value: string }[] = [
    {
      label: 'Episodio',
      value: `${episodeTagKey(ep.season_number ?? 0, ep.episode_number ?? 0)} · ${ep.title}`,
    },
  ]
  if (ep.air_date) meta.push({ label: 'Emitido', value: ep.air_date.slice(0, 10) })
  // Only the flag states anything: an episode whose file exists but could not
  // be read is still "Con archivo", and a payload that carries no flag at all
  // renders unknown — never a "Sin archivo" nobody reported.
  meta.push({
    label: 'Estado',
    value:
      ep.has_file === true ? 'Con archivo' : ep.has_file === false ? 'Sin archivo' : '—',
  })
  return { title: seriesTitle, meta }
}

function episodeRelease(ep: SeriesEpisode, seriesTitle: string): ReleaseSearchItem {
  return {
    type: 'episode',
    id: ep.id ?? 0,
    title: ep.title,
    series_title: seriesTitle,
    season_number: ep.season_number,
    episode_number: ep.episode_number,
    date: ep.air_date ? ep.air_date.slice(0, 10) : undefined,
    source: 'sonarr',
    has_file: ep.has_file === true,
    // The id IS this episode's: the grabs history must be asked under
    // `episode_id=<ep.id>` — under the series id it would answer with some
    // other show's episode carrying the same number.
    idKind: 'episode',
  }
}

function CalidadSeries({
  selectedId,
  onSelect,
}: {
  selectedId: number | null
  onSelect: (selection: MediaSelection) => void
}) {
  const [classFilter, setClassFilter] = useState<QualityClass | 'todas'>('todas')
  const titles = useQuery({ queryKey: ['calidad-series'], queryFn: fetchCalidadSeries })
  const foldersQuery = useQuery({
    queryKey: ['routing-folders'],
    queryFn: fetchRoutingFolders,
    // The folders are settings, not live data: a save invalidates the page anyway.
    staleTime: 5 * 60_000,
  })

  const listError = titles.isError
    ? errorMessage(titles.error)
    : (titles.data?.error ?? null)

  if (foldersQuery.isError) {
    // Without the folders no class can be derived honestly, so the view says
    // why it cannot show anything rather than filing every series as library.
    return (
      <div className="wanted-error" role="alert">
        <strong>No se pudo leer la configuración de carpetas</strong>
        <span>{errorMessage(foldersQuery.error)}</span>
      </div>
    )
  }

  if (listError) {
    return (
      <div className="wanted-error" role="alert">
        <strong>No se pudo consultar Sonarr</strong>
        <span>{listError}</span>
      </div>
    )
  }

  const folders = foldersQuery.data
  if (!folders) {
    return (
      <table className="sec-table sec-q-table">
        <TableHead />
        <tbody>
          <tr>
            <td className="sec-empty" colSpan={CALIDAD_COLUMNS.length}>
              Cargando títulos...
            </td>
          </tr>
        </tbody>
      </table>
    )
  }

  const items = titles.data?.items ?? []
  const counts = { '4K': 0, '3D': 0, 'en biblioteca': 0, 'desconocida': 0 } as Record<QualityClass, number>
  for (const series of items) counts[seriesClass(series, folders)] += 1
  const visible = classFilter === 'todas' ? items : items.filter((s) => seriesClass(s, folders) === classFilter)

  function emptyMessage(): string {
    if (titles.isPending) return 'Cargando títulos...'
    if (items.length === 0) return 'No hay series en el catálogo'
    return `Ninguna serie en la clase ${classFilter}.`
  }

  return (
    <div className="sec-calidad">
      <div className="sec-class-filters" role="group" aria-label="Filtrar por clase">
        <button
          type="button"
          aria-pressed={classFilter === 'todas'}
          className={`sec-class-chip${classFilter === 'todas' ? ' is-active' : ''}`}
          onClick={() => setClassFilter('todas')}
        >
          Todas ({items.length})
        </button>
        {QUALITY_CLASSES.map((cls) => (
          <button
            key={cls}
            type="button"
            aria-pressed={classFilter === cls}
            className={`sec-class-chip${classFilter === cls ? ' is-active' : ''}`}
            onClick={() => setClassFilter(cls)}
          >
            {cls} ({counts[cls]})
          </button>
        ))}
      </div>

      <p className="sec-q-note">
        La clase de una serie sale de la carpeta en la que vive (path_4k → 4K, path_3d → 3D,
        resto → en biblioteca): la lista de Sonarr no trae la calidad por episodio y no se
        consulta, así que esto no es un juicio de calidad como el de Radarr.
      </p>

      <table className="sec-table sec-q-table">
        <TableHead />
        <tbody>
          {titles.isPending || visible.length === 0 ? (
            <tr>
              <td className="sec-empty" colSpan={CALIDAD_COLUMNS.length}>
                {emptyMessage()}
              </td>
            </tr>
          ) : (
            visible.map((series) => {
              const cls = seriesClass(series, folders)
              const routed = routedIn(series.path, folders)
              return (
                <tr
                  key={series.id}
                  className="sec-q-row"
                  tabIndex={0}
                  aria-current={selectedId === series.id ? 'true' : undefined}
                  onClick={() => onSelect({
                    id: series.id,
                    detail: calidadSeriesDetail(series, folders),
                    release: calidadSeriesRelease(series),
                  })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect({
                        id: series.id,
                        detail: calidadSeriesDetail(series, folders),
                        release: calidadSeriesRelease(series),
                      })
                    }
                  }}
                >
                  <td>{series.title}</td>
                  <td>{series.year ?? '—'}</td>
                  <td>
                    <span className="sec-class-badge">{cls}</span>
                  </td>
                  {/* Sonarr's list has no quality: the cell says unknown, the
                      note above says why — never an invented value. */}
                  <td>—</td>
                  <td className="sec-q-path" title={series.path || undefined}>
                    {series.path || '—'}
                  </td>
                  <td>{routed.join(' · ') || '—'}</td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}

function TableHead() {
  return (
    <thead>
      <tr>
        {CALIDAD_COLUMNS.map((c) => (
          <th key={c} scope="col">
            {c}
          </th>
        ))}
      </tr>
    </thead>
  )
}

/* ── Detail-panel tabs (PR 6) ──────────────────────────────────────────────
 * The tabs read facts the SELECTION does not carry: MediaPane hands the panel
 * only { id, detail, release } — MediaDetail deliberately holds no path (its
 * docstring says the panel must not invent one), no raw grab fields and no
 * series id. So the tabs re-read the very list the sub-view rendered the row
 * from, by that list's own query keys: the clicked row is always in one of
 * those loaded pages (a pane listing, or in Estrenos the calendar's own
 * cache), and this join issues no request of its own.
 */

type RowFacts =
  | { state: 'empty' }
  | { state: 'missing' }
  | {
      state: 'ready'
      /** The row's folder, or null when the row carries none (a Faltantes
       *  row: the queue's payload has no path — never a guess). */
      path: string | null
      grabbedAt: number | null
      grabbedDestination: string | null
      /** The series whose episodes the Episodios tab lists. Null when the
       *  row cannot name one (a wanted episode whose payload omitted
       *  `series_id`): the tab says so instead of guessing. */
      seriesId: number | null
    }

/** Every cached row of the lists a sub-view reads from, pages flattened. */
function loadedRows(queryClient: QueryClient, prefix: string): Record<string, unknown>[] {
  const entries = queryClient.getQueriesData<{
    pages?: { items?: Record<string, unknown>[] }[]
    items?: Record<string, unknown>[]
  }>({ queryKey: [prefix] })
  const rows: Record<string, unknown>[] = []
  for (const [, data] of entries) {
    if (!data) continue
    const pages = data.pages ?? [data]
    for (const page of pages) rows.push(...(page.items ?? []))
  }
  return rows
}

function selectedRowFacts(
  queryClient: QueryClient,
  view: SubView,
  selected: MediaSelection | null,
): RowFacts {
  if (!selected) return { state: 'empty' }
  if (view === 'estrenos') {
    // Estrenos renders the CALENDAR: its rows live in the ['calendar', ...]
    // cache the Calendar itself fills, and in NONE of the pane's listings —
    // looking there would report "missing" for a row we hold in full. The
    // type filter keeps an episode from matching a movie of the same id: the
    // cache holds BOTH types.
    const row = loadedRows(queryClient, 'calendar').find(
      (r) => r.id === selected.id && r.type === 'episode',
    )
    if (!row) return { state: 'missing' }
    return {
      state: 'ready',
      // A CalendarItem carries no folder and no series id (Sonarr's calendar
      // payload omits it): null is what the item said — never a guess, so
      // Archivos answers "no tiene ruta" and Episodios cannot name a series.
      path: null,
      grabbedAt: typeof row.grabbed_at === 'number' ? row.grabbed_at : null,
      grabbedDestination:
        typeof row.grabbed_destination === 'string' ? row.grabbed_destination : null,
      seriesId: null,
    }
  }
  const prefix =
    view === 'faltantes'
      ? 'wanted-episodes-infinite'
      : view === 'calidad'
        ? 'calidad-series'
        : 'all-series-infinite'
  const row = loadedRows(queryClient, prefix).find((r) => r.id === selected.id)
  if (!row) return { state: 'missing' }
  const grabbedAt = typeof row.grabbed_at === 'number' ? row.grabbed_at : null
  const grabbedDestination =
    typeof row.grabbed_destination === 'string' ? row.grabbed_destination : null
  if (view === 'faltantes') {
    // A WantedEpisode: no path field at all, and its series id (what the
    // Episodios tab needs) may be null in the payload — never inferred.
    return {
      state: 'ready',
      path: null,
      grabbedAt,
      grabbedDestination,
      seriesId: typeof row.series_id === 'number' ? row.series_id : null,
    }
  }
  // AllSeries: the id IS the series id, and the folder is its own.
  const rawPath = typeof row.path === 'string' ? row.path : ''
  return {
    state: 'ready',
    path: rawPath || null,
    grabbedAt,
    grabbedDestination,
    seriesId: selected.id,
  }
}

const ROW_MISSING = 'No se pudo leer la fila seleccionada.'

/** File size in human units — the same reading FileManager's list does. */
function formatSize(bytes: number): string {
  if (bytes === 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** The Archivos tab: GET /api/files/browse for the selected row's folder.
 *  Read-only by construction — rename/delete/copy live in the Archivos PAGE
 *  (retired later, not here); this listing has no actions at all. */
function PanelFiles({ facts }: { facts: RowFacts }) {
  if (facts.state === 'empty') return null
  if (facts.state === 'missing') return <p className="sec-tab-note">{ROW_MISSING}</p>
  if (!facts.path) return <p className="sec-tab-note">Esta entrada no tiene ruta</p>
  return <FilesList path={facts.path} />
}

function FilesList({ path }: { path: string }) {
  const query = useQuery({ queryKey: ['panel-browse', path], queryFn: () => browsePath(path) })
  if (query.isPending) return <p className="sec-tab-note">Cargando ruta…</p>
  if (query.isError) {
    return (
      <div className="wanted-error" role="alert">
        <strong>No se pudo leer la ruta</strong>
        <span>{errorMessage(query.error)}</span>
      </div>
    )
  }
  // browsePath answers failures on the body: a file where a folder was asked
  // for reads "No es un directorio", and a blocked path arrives as FastAPI's
  // `detail`. Neither may render as an empty listing.
  const data = query.data as BrowseResponse & { detail?: string }
  const failure = data.error ?? data.detail
  if (!data.ok) {
    return (
      <div className="wanted-error" role="alert">
        <strong>No se pudo leer la ruta</strong>
        <span>{failure ?? 'respuesta inesperada del servidor'}</span>
      </div>
    )
  }
  if (data.items.length === 0) return <p className="sec-tab-note">Esta carpeta está vacía</p>
  return (
    <table className="sec-table sec-files-table">
      <thead>
        <tr>
          <th scope="col">Nombre</th>
          <th scope="col">Tamaño</th>
          <th scope="col">Modificado</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((item) => (
          <tr key={item.path}>
            <td className="sec-file-name" title={item.path}>
              {item.name}
            </td>
            <td>{item.is_dir ? '—' : formatSize(item.size)}</td>
            <td>{new Date(item.modified * 1000).toLocaleDateString('es-ES')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The Episodios tab: every episode of the selected series, from the same
 *  endpoint the "En carpeta" navigator resolves S##E## names against, now
 *  with the file facts PR #151 added to the payload. The list groups by
 *  season behind one header row, filters through the season chips and marks
 *  ONE episode — which never becomes the selection: see `selectRow`. */
function PanelEpisodes({
  facts,
  marked,
  onMark,
}: {
  facts: RowFacts
  marked: SeriesEpisode | null
  onMark: (ep: SeriesEpisode) => void
}) {
  if (facts.state === 'empty') return null
  if (facts.state === 'missing') return <p className="sec-tab-note">{ROW_MISSING}</p>
  if (facts.seriesId == null) {
    return <p className="sec-tab-note">Esta entrada no tiene serie asociada</p>
  }
  return <EpisodesList seriesId={facts.seriesId} marked={marked} onMark={onMark} />
}

/** Identity of an episode row: its own id when the payload carries one, the
 *  S##E## pair otherwise — never the array position, which shifts with the
 *  season filter. */
function episodeIdentity(ep: SeriesEpisode): string {
  return ep.id != null ? `ep:${ep.id}` : `ep:${ep.season_number ?? 0}x${ep.episode_number ?? 0}`
}

function seasonLabel(season: number): string {
  return `Season ${String(season).padStart(2, '0')}`
}

/** The row's own state, exactly as far as the payload states it: only an
 *  explicit `has_file` says anything. A file that exists but could not be
 *  read stays "En biblioteca"; a payload without the flag renders unknown —
 *  never a state nobody reported. */
function episodeState(ep: SeriesEpisode): string {
  if (ep.has_file === true) return 'En biblioteca'
  if (ep.has_file === false) return 'Falta'
  return '—'
}

/** The pill's tone: only an explicit `has_file` may colour it. Unknown stays
 *  untinted — a dash is not a state and must not be painted like one. */
function pillTone(ep: SeriesEpisode): string {
  if (ep.has_file === true) return ' is-ok'
  if (ep.has_file === false) return ' is-missing'
  return ''
}

/** A quality badge, only when the payload states a quality. 4K is the one
 *  class Sonarr's name carries that we can trust: an episode has no `is3d`, so
 *  no 3D tag is ever invented here. */
function qualityBadge(quality: string | null): { label: string; tone: string } | null {
  if (!quality) return null
  return { label: quality, tone: quality.toLowerCase().endsWith('2160p') ? ' is-4k' : '' }
}

/** Seasons in ascending order, each with the episodes that belong to it. */
function groupBySeason(
  episodes: SeriesEpisode[],
): { season: number; episodes: SeriesEpisode[] }[] {
  const bySeason = new Map<number, SeriesEpisode[]>()
  for (const ep of episodes) {
    const season = ep.season_number ?? 0
    const group = bySeason.get(season)
    if (group) group.push(ep)
    else bySeason.set(season, [ep])
  }
  return [...bySeason.entries()]
    .sort(([a], [b]) => a - b)
    .map(([season, list]) => ({ season, episodes: list }))
}

/** One season header: its name, the year its episodes aired in (omitted when
 *  no episode of the season carries an air date) and only the clauses that
 *  are true — a zero count is omitted, never shown as "0 en biblioteca". */
function seasonHeader(episodes: SeriesEpisode[], season: number) {
  const year = episodes.find((ep) => ep.air_date)?.air_date.slice(0, 4)
  const clauses: string[] = []
  const inLibrary = episodes.filter((ep) => ep.has_file === true).length
  const missing = episodes.filter((ep) => ep.has_file === false).length
  if (inLibrary > 0) clauses.push(`${inLibrary} en biblioteca`)
  if (missing > 0) clauses.push(`${missing} falta`)
  return (
    <>
      <span className="sec-season-name">{seasonLabel(season)}</span>
      {year && <span className="sec-season-year">{year}</span>}
      {clauses.length > 0 && <span className="sec-season-counts">· {clauses.join(' · ')}</span>}
    </>
  )
}

function EpisodesList({
  seriesId,
  marked,
  onMark,
}: {
  seriesId: number
  marked: SeriesEpisode | null
  onMark: (ep: SeriesEpisode) => void
}) {
  const [season, setSeason] = useState<number | 'todas'>('todas')
  const query = useQuery({
    queryKey: ['panel-series-episodes', seriesId],
    queryFn: () => fetchSeriesEpisodes(seriesId),
  })
  if (query.isPending) return <p className="sec-tab-note">Cargando episodios…</p>
  if (query.isError) {
    return (
      <div className="wanted-error" role="alert">
        <strong>No se pudieron leer los episodios</strong>
        <span>{errorMessage(query.error)}</span>
      </div>
    )
  }
  // The backend reports arr failures on the body: HTTP 200 with `error` is a
  // failed read, not an episode-less series.
  if (query.data.error) {
    return (
      <div className="wanted-error" role="alert">
        <strong>No se pudieron leer los episodios</strong>
        <span>{query.data.error}</span>
      </div>
    )
  }
  if (query.data.episodes.length === 0) {
    return <p className="sec-tab-note">Esta serie no tiene episodios</p>
  }

  const episodes = query.data.episodes
  const seasons = [...new Set(episodes.map((ep) => ep.season_number ?? 0))].sort((a, b) => a - b)
  // The panel may have moved to another title while a season was on duty:
  // a season this series does not own falls back to Todas instead of
  // filtering the table down to nothing.
  const activeSeason = season !== 'todas' && seasons.includes(season) ? season : 'todas'
  const visible =
    activeSeason === 'todas'
      ? episodes
      : episodes.filter((ep) => (ep.season_number ?? 0) === activeSeason)
  const groups = groupBySeason(visible)
  const markedKey = marked ? episodeIdentity(marked) : null
  const seasonTotal = (value: number) =>
    episodes.filter((ep) => (ep.season_number ?? 0) === value).length

  return (
    <>
      <div className="eseasons" role="group" aria-label="Filtrar por temporada">
        <button
          type="button"
          aria-pressed={activeSeason === 'todas'}
          className={`sec-class-chip${activeSeason === 'todas' ? ' is-active' : ''}`}
          onClick={() => setSeason('todas')}
        >
          Todas ({episodes.length})
        </button>
        {seasons.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={activeSeason === value}
            className={`sec-class-chip${activeSeason === value ? ' is-active' : ''}`}
            onClick={() => setSeason(value)}
          >
            {seasonLabel(value)} ({seasonTotal(value)})
          </button>
        ))}
      </div>

      {/* The prototype's shape: two self-describing lines per episode, not a grid
          with column heads. `role="listbox"`/`role="option"` are what make
          `aria-selected` valid — without them a marked row is invalid ARIA
          rather than merely unlabelled. */}
      <div className="sec-table sec-ep-table" role="listbox" aria-label="Episodios">
        {groups.map(({ season: groupSeason, episodes: groupEpisodes }) => (
          <Fragment key={groupSeason}>
            <div className="sec-season-head" role="group" aria-label={seasonLabel(groupSeason)}>
              {seasonHeader(groupEpisodes, groupSeason)}
            </div>
            {groupEpisodes.map((ep) => {
              const key = episodeIdentity(ep)
              const isMarked = key === markedKey
              const badge = qualityBadge(ep.quality)
              return (
                <div
                  key={key}
                  className={`sec-ep-row${isMarked ? ' is-marked' : ''}`}
                  role="option"
                  tabIndex={0}
                  aria-selected={isMarked}
                  onClick={() => onMark(ep)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onMark(ep)
                    }
                  }}
                >
                  <div className="sec-ep-top">
                    <span className="sec-ep-code">
                      {episodeTagKey(ep.season_number ?? 0, ep.episode_number ?? 0)}
                    </span>
                    <span className="sec-ep-name">{ep.title}</span>
                    <span className={`sec-ep-pill${pillTone(ep)}`}>{episodeState(ep)}</span>
                  </div>
                  <div className="sec-ep-bot">
                    <span className="sec-ep-date">
                      {ep.air_date ? ep.air_date.slice(0, 10) : '—'}
                    </span>
                    {/* Absent quality is a dash, never a badge: the payload says
                        nothing, so nothing is claimed. */}
                    {badge ? (
                      <span className={`sec-q-tag${badge.tone}`}>{badge.label}</span>
                    ) : (
                      <span className="sec-ep-qual">—</span>
                    )}
                    <span className="sec-ep-path" title={ep.path || undefined}>
                      {ep.path || '—'}
                    </span>
                  </div>
                </div>
              )
            })}
          </Fragment>
        ))}
      </div>
    </>
  )
}

/** The Historial tab: the row's own grab record — grabbed_at and
 *  grabbed_destination — never /api/auto-copy/history, which is a global log
 *  and would imply a per-item history that does not exist. */
function PanelHistory({ facts }: { facts: RowFacts }) {
  if (facts.state === 'empty') return null
  if (facts.state === 'missing') return <p className="sec-tab-note">{ROW_MISSING}</p>
  if (facts.grabbedAt == null) return <p className="sec-tab-note">Nunca se pidió desde la app</p>
  return (
    <dl className="sec-history">
      <dt>Pedido el</dt>
      <dd>{new Date(facts.grabbedAt * 1000).toLocaleDateString('es-ES')}</dd>
      <dt>Enviado a</dt>
      {/* null destination means the arr's own library, per the type's contract. */}
      <dd>{facts.grabbedDestination ?? 'Biblioteca del arr'}</dd>
    </dl>
  )
}

export function Series() {
  const [view, setView] = useState<SubView>('biblioteca')
  const [selected, setSelected] = useState<MediaSelection | null>(null)
  // Which detail tab is on screen. A row selection lands on Episodios — the
  // operator opens a series on its episodes — and every other tab is live.
  const [detailTab, setDetailTab] = useState<string>('Episodios')
  // The episode marked INSIDE the panel, never folded into `selected`: that
  // selection is the SERIES, and PanelEpisodes renders from facts.seriesId
  // derived from it — an episode's id would null that id and unmount the
  // very list that marked it. Cleared wherever `selected` changes.
  const [markedEpisode, setMarkedEpisode] = useState<SeriesEpisode | null>(null)
  const queryClient = useQueryClient()
  const uid = useId()
  const active = SUB_VIEWS.find((s) => s.id === view) ?? SUB_VIEWS[0]
  const facts = selectedRowFacts(queryClient, view, selected)
  // The header speaks for the marked episode when there is one, and for the
  // selection otherwise — `selected` itself is only read, never rewritten.
  const detail = selected
    ? markedEpisode
      ? episodeDetail(markedEpisode, selected.detail.title)
      : selected.detail
    : null

  function changeView(next: SubView) {
    setView(next)
    // The selection belongs to the list it came from: a switch resets it and
    // the mark it carried, and with it the tab that was showing that row's
    // data — back to Releases, where a fresh view waits for its own selection.
    setSelected(null)
    setMarkedEpisode(null)
    setDetailTab('Releases')
  }

  /** A row of the LIST becomes the selection. The tab follows it to
   *  Episodios, and any episode mark dies with the row that carried it. */
  function selectRow(selection: MediaSelection) {
    setSelected(selection)
    setMarkedEpisode(null)
    setDetailTab('Episodios')
  }

  /** Marking an episode keeps the series selected and sends the panel to the
   *  search that episode needs — the Releases block keys its item on the mark,
   *  not on the series row. */
  function markEpisode(ep: SeriesEpisode) {
    setMarkedEpisode(ep)
    setDetailTab('Releases')
  }

  return (
    <section className="section-shell">
      <header className="sec-header">
        <h2>Series</h2>
        <p>Aquí viven tus series: biblioteca, faltantes, estrenos y calidad en una sola vista.</p>
      </header>

      <div className="sec-subtabs" role="tablist" aria-label="Sub-vistas de Series">
        {SUB_VIEWS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`${uid}-tab-${s.id}`}
            aria-selected={view === s.id}
            aria-controls={`${uid}-list`}
            className={`sec-subtab${view === s.id ? ' is-active' : ''}`}
            onClick={() => changeView(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="sec-split">
        <section
          className="sec-master"
          role="tabpanel"
          id={`${uid}-list`}
          aria-labelledby={`${uid}-tab-${active.id}`}
        >
          <div className="sec-master-head">
            <span className="sec-master-title">Series</span>
            <span className="sec-master-sub">{active.label}</span>
          </div>

          {view === 'estrenos' ? (
            // The calendar IS the list of this sub-view — episode items only.
            // It keeps its own date range and navigation; a card click
            // reports the selection instead of opening the release search
            // as a modal, which is what the other sub-views' rows do.
            <Calendar
              type="episode"
              onSelect={(item) => {
                // A calendar card is not a row of the list: it is an episode
                // with no series id to list (see selectedRowFacts), so it
                // selects without landing on Episodios — Releases stays on
                // duty, as it has since the view switch put it there.
                setMarkedEpisode(null)
                setSelected({
                  id: item.id,
                  detail: estrenoDetail(item),
                  release: estrenoRelease(item),
                })
              }}
            />
          ) : view === 'calidad' ? (
            // PR 4: the class list. Its rows are selectable like the pane's.
            <CalidadSeries selectedId={selected?.id ?? null} onSelect={selectRow} />
          ) : (
            // The pane styles its rows under a `.wanted` ancestor (its action
            // buttons are `.wanted .search-item`), so the column provides it.
            // 'section' is what gives them the prototype's dense shape.
            <div className="wanted">
              <MediaPane
                kind="episodes"
                namespace="series"
                filter={view === 'biblioteca' ? 'all' : 'missing'}
                // The two buttons ARE the two sub-views: "Faltantes" and
                // "Todas" are the same choice as the tab above, so they are
                // wired to it rather than holding a second filter the tabs
                // would contradict. The name search beside them is independent.
                showFilterButtons
                onFilterChange={(f) => changeView(f === 'missing' ? 'faltantes' : 'biblioteca')}
                selectedId={selected?.id ?? null}
                onSelect={selectRow}
                variant="section"
              />
            </div>
          )}
        </section>

        <section className="sec-detail" aria-label="Panel de detalle">
          <div className="sec-detail-head">
            {detail?.poster ? (
              <img
                className="sec-poster sec-poster-img"
                src={detail.poster}
                alt=""
              />
            ) : (
              <span className="sec-poster" aria-hidden="true" />
            )}
            <div className="sec-detail-titles">
              <h3>{detail ? detail.title : 'Sin selección'}</h3>
              <dl className="sec-meta">
                {detail ? (
                  <>
                    {detail.meta.map((m) => (
                      <Fragment key={m.label}>
                        <dt>{m.label}</dt>
                        <dd>{m.value}</dd>
                      </Fragment>
                    ))}
                    {detail.grab && (
                      <>
                        <dt>Descarga</dt>
                        <dd className="sec-grabbed">{detail.grab}</dd>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <dt>Año</dt>
                    <dd>—</dd>
                    <dt>Estado</dt>
                    <dd>—</dd>
                    <dt>Calidad</dt>
                    <dd>—</dd>
                    <dt>Ruta</dt>
                    <dd>—</dd>
                  </>
                )}
              </dl>
            </div>
          </div>

          <div className="sec-detail-tabs" role="group" aria-label="Pestañas del detalle">
            {DETAIL_TABS.map((t) => (
              <button
                key={t}
                type="button"
                className={`sec-dtab${t === detailTab ? ' is-active' : ''}`}
                // Every tab is real since PR 6: Releases holds the search
                // (PR 5), Episodios the series' episodes, Archivos the folder
                // listing, Historial the row's own grab record. None is a
                // disabled placeholder any more.
                onClick={() => setDetailTab(t)}
              >
                {t}
              </button>
            ))}
          </div>

          {!selected && (
            <p className="sec-empty sec-empty-detail">{PANEL_EMPTY}</p>
          )}

          {/* The release search, inline in the panel: for the row the
              operator selected — or, once an episode is marked, for THAT
              episode. A different key is a different search: no state
              (results, filters, marks) may leak from one to the next, which
              is why marking an episode changes the key as a row change does. */}
          {selected && detailTab === 'Releases' && (
            <ReleaseSearchModal
              key={markedEpisode ? episodeIdentity(markedEpisode) : selected.id}
              item={
                markedEpisode
                  ? episodeRelease(markedEpisode, selected.detail.title)
                  : selected.release
              }
              presentation="panel"
            />
          )}

          {/* PR 6: the three tabs that used to be markers. Each renders its
              own honest states; with no selection the panel shows PANEL_EMPTY
              above and no tab content at all. */}
          {selected && detailTab === 'Episodios' && (
            <PanelEpisodes facts={facts} marked={markedEpisode} onMark={markEpisode} />
          )}
          {selected && detailTab === 'Archivos' && <PanelFiles facts={facts} />}
          {selected && detailTab === 'Historial' && <PanelHistory facts={facts} />}

          <p className="sec-panel-note">{PANEL_NOTE}</p>
        </section>
      </div>

      <section className="sec-notes">
        <h3>Notas de implementación</h3>
        <ol>
          {NOTES.map((n) => (
            <li key={n.pr}>
              <strong>{n.pr}</strong> — {n.text}
            </li>
          ))}
        </ol>
      </section>
    </section>
  )
}
