import { Fragment, useId, useState } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Calendar } from './Calendar'
import { MediaPane, type MediaDetail, type MediaSelection } from './MediaPane'
import { ReleaseSearchModal, type ReleaseSearchItem } from './ReleaseSearchModal'
import { apiFetch } from '../api/auth'
import { browsePath } from '../api/files'
import { formatGrabMark } from '../utils/grabMark'
import type { AllMovie, BrowseResponse, PaginatedResponse } from '../types'
import './Sections.css'

/**
 * Películas — master–detail (F-08).
 *
 * PR 6 of the plan: the detail panel's tabs all carry real data. Releases
 * (PR 5) holds the release search inline; Archivos lists the selected row's
 * folder read-only through GET /api/files/browse; Historial reads the row's
 * own `grabbed_at`/`grabbed_destination` — this app's own grab record, never
 * the global auto-copy log. The sub-views are unchanged: Biblioteca and
 * Faltantes render MediaPane, Estrenos the calendar, and Calidad the class
 * list — movies grouped by the quality of the file Radarr owns.
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

const DETAIL_TABS = ['Releases', 'Archivos', 'Historial']

const NOTES: { pr: string; text: string }[] = [
  { pr: 'PR 1 ✅', text: 'techo: navegación, rutas y la envoltura maestro–detalle.' },
  { pr: 'PR 2 ✅', text: 'Biblioteca y Faltantes muestran las listas reales, extraídas de la sección Faltantes; la selección rellena el panel de detalle.' },
  { pr: 'PR 3 ✅', text: 'Estrenos muestra el calendario: solo películas aquí, solo episodios en Series.' },
  { pr: 'PR 4 ✅', text: 'Calidad agrupa por clase: aquí la clase sale de la calidad del archivo de Radarr, con la carpeta como confirmación; en Series sale de su carpeta (Sonarr no da calidad en su lista).' },
  { pr: 'PR 5 ✅', text: 'buscar releases vive en la pestaña Releases del panel y las filas adoptan la forma del prototipo (mini póster, estado, calidad y ruta); desde la lista ya no se abre ningún modal, el calendario de Estrenos todavía sí.' },
  { pr: 'PR 6 ✅', text: 'Archivos e Historial dejan de ser marcadores: la pestaña Archivos lista la ruta de la selección con browsePath (solo lectura) y Historial enseña el grabbed_at/grabbed_destination de la propia fila.' },
  { pr: 'PR 7 (este) ✅', text: 'los menús Faltantes y Calendario se retiran del lateral y sus tests migran a las secciones.' },
]

const PANEL_EMPTY = 'Selecciona un elemento de la lista para ver su detalle.'
const PANEL_NOTE =
  'La búsqueda de releases vive en la pestaña Releases de este panel (PR 5); desde el calendario de Estrenos todavía se abre como modal. Las pestañas Archivos e Historial se llenan con datos reales desde el PR 6.'

/* ── Calidad (PR 4) ─────────────────────────────────────────────────────────
 * The four classes a title can land in, mirroring F-01's routing: 4K and 3D
 * are folders, "en biblioteca" is the arr's own library, and "desconocida"
 * is a movie whose file quality Radarr could not tell us.
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

/** Which routing folders hold the title, named by their settings keys; the
 *  cell renders "—" when it lives in neither. */
function routedIn(path: string, folders: RoutingFolders): string[] {
  const routed: string[] = []
  if (inFolder(path, folders.path4k)) routed.push('path_4k')
  if (inFolder(path, folders.path3d)) routed.push('path_3d')
  return routed
}

/** The class of a movie, from facts only: Radarr's file quality (empty is
 *  unknown, never guessed) plus the repo's own routing rules — 3D outranks
 *  the resolution, and a 2160p file is the 4K class. */
function movieClass(movie: AllMovie, folders: RoutingFolders): QualityClass {
  const quality = (movie.quality ?? '').trim()
  if (!quality) return 'desconocida'
  if (inFolder(movie.path, folders.path3d)) return '3D'
  if (quality.toLowerCase().endsWith('2160p')) return '4K'
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
async function fetchCalidadMovies(): Promise<PaginatedResponse<AllMovie>> {
  const res = await apiFetch('/api/wanted/all?page=1&page_size=0', {})
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string }
    return {
      items: [],
      total: 0,
      error: typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}`,
    }
  }
  const body = (await res.json()) as PaginatedResponse<AllMovie>
  return { ...body, items: body.items ?? [] }
}

function calidadMovieDetail(movie: AllMovie, folders: RoutingFolders): MediaDetail {
  const routed = routedIn(movie.path, folders)
  const meta: { label: string; value: string }[] = []
  if (movie.year != null) meta.push({ label: 'Año', value: String(movie.year) })
  meta.push({ label: 'Clase', value: movieClass(movie, folders) })
  meta.push({ label: 'Calidad', value: movie.quality || '—' })
  meta.push({ label: 'Ruta', value: movie.path || '—' })
  meta.push({ label: 'Enrutado', value: routed.join(' · ') || '—' })
  return {
    title: movie.title,
    poster: movie.remotePoster || undefined,
    meta,
    grab: formatGrabMark(movie.grabbed_at, movie.grabbed_destination) ?? undefined,
  }
}

/** What a Calidad row hands the panel's Releases tab: the same item the
 *  release-search modal would open for this movie. */
function calidadMovieRelease(movie: AllMovie): ReleaseSearchItem {
  return {
    type: 'movie',
    id: movie.id,
    title: movie.title,
    year: movie.year,
    source: 'radarr',
    remotePoster: movie.remotePoster,
    has_file: movie.has_file,
  }
}

function CalidadMovies({
  selectedId,
  onSelect,
}: {
  selectedId: number | null
  onSelect: (selection: MediaSelection) => void
}) {
  const [classFilter, setClassFilter] = useState<QualityClass | 'todas'>('todas')
  const titles = useQuery({ queryKey: ['calidad-movies'], queryFn: fetchCalidadMovies })
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
    // why it cannot show anything rather than filing every title as library.
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
        <strong>No se pudo consultar Radarr</strong>
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
  for (const movie of items) counts[movieClass(movie, folders)] += 1
  const visible = classFilter === 'todas' ? items : items.filter((m) => movieClass(m, folders) === classFilter)

  function emptyMessage(): string {
    if (titles.isPending) return 'Cargando títulos...'
    if (items.length === 0) return 'No hay películas en el catálogo'
    return `Ninguna película en la clase ${classFilter}.`
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
        La clase sale de la calidad del archivo que Radarr tiene (vacío = desconocida) y de la
        carpeta en la que vive: 3D manda sobre la resolución.
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
            visible.map((movie) => {
              const cls = movieClass(movie, folders)
              const routed = routedIn(movie.path, folders)
              return (
                <tr
                  key={movie.id}
                  className="sec-q-row"
                  tabIndex={0}
                  aria-current={selectedId === movie.id ? 'true' : undefined}
                  onClick={() => onSelect({
                    id: movie.id,
                    detail: calidadMovieDetail(movie, folders),
                    release: calidadMovieRelease(movie),
                  })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect({
                        id: movie.id,
                        detail: calidadMovieDetail(movie, folders),
                        release: calidadMovieRelease(movie),
                      })
                    }
                  }}
                >
                  <td>{movie.title}</td>
                  <td>{movie.year ?? '—'}</td>
                  <td>
                    <span className="sec-class-badge">{cls}</span>
                  </td>
                  <td>{movie.quality || '—'}</td>
                  <td className="sec-q-path" title={movie.path || undefined}>
                    {movie.path || '—'}
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
 * docstring says the panel must not invent one) and no raw grab fields. So
 * the tabs re-read the very list the pane rendered the row from, by the
 * pane's own query keys: the clicked row is always in one of those loaded
 * pages, and this join issues no request of its own.
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
      ? 'wanted-movies-infinite'
      : view === 'calidad'
        ? 'calidad-movies'
        : 'all-movies-infinite'
  const row = loadedRows(queryClient, prefix).find((r) => r.id === selected.id)
  if (!row) return { state: 'missing' }
  const rawPath = typeof row.path === 'string' ? row.path : ''
  return {
    state: 'ready',
    // A WantedMovie has no `path` field at all: "" here is what the row said,
    // and the Archivos tab renders it as the honest "no tiene ruta".
    path: view === 'faltantes' || !rawPath ? null : rawPath,
    grabbedAt: typeof row.grabbed_at === 'number' ? row.grabbed_at : null,
    grabbedDestination:
      typeof row.grabbed_destination === 'string' ? row.grabbed_destination : null,
    seriesId: null,
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

export function Peliculas() {
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
        <h2>Películas</h2>
        <p>Aquí viven tus películas: biblioteca, faltantes, estrenos y calidad en una sola vista.</p>
      </header>

      <div className="sec-subtabs" role="tablist" aria-label="Sub-vistas de Películas">
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
            <span className="sec-master-title">Películas</span>
            <span className="sec-master-sub">{active.label}</span>
          </div>

          {view === 'estrenos' ? (
            // The calendar IS the list of this sub-view — movie items only.
            // It keeps its own date range, navigation and card actions,
            // including opening the release search.
            <Calendar type="movie" />
          ) : view === 'calidad' ? (
            // PR 4: the class list. Its rows are selectable like the pane's.
            <CalidadMovies selectedId={selected?.id ?? null} onSelect={setSelected} />
          ) : (
            // The pane styles its rows under a `.wanted` ancestor (its action
            // buttons are `.wanted .search-item`), so the column provides it.
            // 'section' is what gives them the prototype's dense shape.
            <div className="wanted">
              <MediaPane
                kind="movies"
                namespace="peliculas"
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
                // (PR 5), Archivos the folder listing, Historial the row's
                // own grab record. None is a disabled placeholder any more.
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

          {/* PR 6: the two tabs that used to be markers. Each renders its own
              honest states; with no selection the panel shows PANEL_EMPTY
              above and no tab content at all. */}
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
