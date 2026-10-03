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
import type { AllSeries, BrowseResponse, PaginatedResponse } from '../types'
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
  { id: 'faltantes', label: 'Faltantes' },
  { id: 'estrenos', label: 'Estrenos' },
  { id: 'calidad', label: 'Calidad' },
]

const DETAIL_TABS = ['Episodios', 'Releases', 'Archivos', 'Historial']

const NOTES: { pr: string; text: string }[] = [
  { pr: 'PR 1 ✅', text: 'techo: navegación, rutas y la envoltura maestro–detalle.' },
  { pr: 'PR 2 ✅', text: 'Biblioteca y Faltantes muestran las listas reales, extraídas de la sección Faltantes; la selección rellena el panel de detalle.' },
  { pr: 'PR 3 ✅', text: 'Estrenos muestra el calendario: solo episodios aquí, solo películas en Películas.' },
  { pr: 'PR 4 ✅', text: 'Calidad agrupa por clase: aquí la clase sale de la carpeta en la que vive cada serie (Sonarr no da calidad en su lista); en Películas sale de la calidad del archivo de Radarr.' },
  { pr: 'PR 5 ✅', text: 'buscar releases vive en la pestaña Releases del panel y las filas adoptan la forma del prototipo (mini póster, estado, calidad y ruta); desde la lista ya no se abre ningún modal, el calendario de Estrenos todavía sí.' },
  { pr: 'PR 6 (este) ✅', text: 'Episodios, Archivos e Historial dejan de ser marcadores: los episodios salen de /api/wanted/series/{id}/episodes, la ruta de la selección se lista con browsePath (solo lectura) y Historial enseña el grabbed_at/grabbed_destination de la propia fila.' },
  { pr: 'PR 7 (retirar Faltantes/Calendario + migrar sus tests) ⬜', text: 'los menús Faltantes y Calendario se retiran del lateral y sus tests migran a las secciones.' },
]

const PANEL_EMPTY = 'Selecciona un elemento de la lista para ver su detalle.'
const PANEL_NOTE =
  'La búsqueda de releases vive en la pestaña Releases de este panel (PR 5); desde el calendario de Estrenos todavía se abre como modal. Las pestañas Episodios, Archivos e Historial se llenan con datos reales desde el PR 6.'

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
 * series id. So the tabs re-read the very list the pane rendered the row
 * from, by the pane's own query keys: the clicked row is always in one of
 * those loaded pages, and this join issues no request of its own.
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
 *  endpoint the "En carpeta" navigator resolves S##E## names against. Only
 *  fields that payload carries: code, title and air date — no has_file,
 *  because the response has no such field. */
function PanelEpisodes({ facts }: { facts: RowFacts }) {
  if (facts.state === 'empty') return null
  if (facts.state === 'missing') return <p className="sec-tab-note">{ROW_MISSING}</p>
  if (facts.seriesId == null) {
    return <p className="sec-tab-note">Esta entrada no tiene serie asociada</p>
  }
  return <EpisodesList seriesId={facts.seriesId} />
}

function EpisodesList({ seriesId }: { seriesId: number }) {
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
  return (
    <table className="sec-table sec-ep-table">
      <thead>
        <tr>
          <th scope="col">Episodio</th>
          <th scope="col">Título</th>
          <th scope="col">Emitido</th>
        </tr>
      </thead>
      <tbody>
        {query.data.episodes.map((ep, index) => (
          <tr key={ep.id ?? index}>
            <td>{episodeTagKey(ep.season_number ?? 0, ep.episode_number ?? 0)}</td>
            <td>{ep.title}</td>
            <td>{ep.air_date ? ep.air_date.slice(0, 10) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
  // Which detail tab is on screen. Releases first: it is the tab the panel
  // has opened with since PR 5, and every other tab is live since PR 6.
  const [detailTab, setDetailTab] = useState<string>('Releases')
  const queryClient = useQueryClient()
  const uid = useId()
  const active = SUB_VIEWS.find((s) => s.id === view) ?? SUB_VIEWS[0]
  const facts = selectedRowFacts(queryClient, view, selected)

  function changeView(next: SubView) {
    setView(next)
    // The selection belongs to the list it came from: a switch resets it,
    // and with it the tab that was showing the deselected row's data.
    setSelected(null)
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
            // It keeps its own date range, navigation and card actions,
            // including opening the release search.
            <Calendar type="episode" />
          ) : view === 'calidad' ? (
            // PR 4: the class list. Its rows are selectable like the pane's.
            <CalidadSeries selectedId={selected?.id ?? null} onSelect={setSelected} />
          ) : (
            // The pane styles its rows under a `.wanted` ancestor (its action
            // buttons are `.wanted .search-item`), so the column provides it.
            // 'section' is what gives them the prototype's dense shape; the
            // Faltantes page keeps its own rows untouched.
            <div className="wanted">
              <MediaPane
                kind="episodes"
                namespace="series"
                filter={view === 'biblioteca' ? 'all' : 'missing'}
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
                variant="section"
              />
            </div>
          )}
        </section>

        <section className="sec-detail" aria-label="Panel de detalle">
          <div className="sec-detail-head">
            {selected?.detail.poster ? (
              <img
                className="sec-poster sec-poster-img"
                src={selected.detail.poster}
                alt=""
              />
            ) : (
              <span className="sec-poster" aria-hidden="true" />
            )}
            <div className="sec-detail-titles">
              <h3>{selected ? selected.detail.title : 'Sin selección'}</h3>
              <dl className="sec-meta">
                {selected ? (
                  <>
                    {selected.detail.meta.map((m) => (
                      <Fragment key={m.label}>
                        <dt>{m.label}</dt>
                        <dd>{m.value}</dd>
                      </Fragment>
                    ))}
                    {selected.detail.grab && (
                      <>
                        <dt>Descarga</dt>
                        <dd className="sec-grabbed">{selected.detail.grab}</dd>
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

          {/* The release search, inline in the panel, for the row the
              operator selected — Releases tab since PR 5. A different row is
              a different search: keyed so no state (results, filters, marks)
              leaks from one title to the next. */}
          {selected && detailTab === 'Releases' && (
            <ReleaseSearchModal
              key={selected.id}
              item={selected.release}
              presentation="panel"
            />
          )}

          {/* PR 6: the three tabs that used to be markers. Each renders its
              own honest states; with no selection the panel shows PANEL_EMPTY
              above and no tab content at all. */}
          {selected && detailTab === 'Episodios' && <PanelEpisodes facts={facts} />}
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
