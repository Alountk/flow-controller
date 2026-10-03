import { Fragment, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Calendar } from './Calendar'
import { MediaPane, type MediaDetail, type MediaSelection } from './MediaPane'
import { apiFetch } from '../api/auth'
import { formatGrabMark } from '../utils/grabMark'
import type { AllSeries, PaginatedResponse } from '../types'
import './Sections.css'

/**
 * Series — master–detail (F-08).
 *
 * PR 4 of the plan: every sub-view tab is now live. Biblioteca and Faltantes
 * render MediaPane, Estrenos the calendar, and Calidad the class list — series
 * grouped by the folder they live in, because Sonarr's list carries no quality.
 * Selecting a row fills the detail panel with that row's own data. The twin of
 * Películas: same model, different words.
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

const DETAIL_TABS = ['Episodios', 'Releases', 'Archivos']
const QUALITIES = ['1080p', '4K', '3D']

const NOTES: { pr: string; text: string }[] = [
  { pr: 'PR 1 ✅', text: 'techo: navegación, rutas y la envoltura maestro–detalle.' },
  { pr: 'PR 2 ✅', text: 'Biblioteca y Faltantes muestran las listas reales, extraídas de la sección Faltantes; la selección rellena el panel de detalle.' },
  { pr: 'PR 3 ✅', text: 'Estrenos muestra el calendario: solo episodios aquí, solo películas en Películas.' },
  { pr: 'PR 4 (este) ✅', text: 'Calidad agrupa por clase: aquí la clase sale de la carpeta en la que vive cada serie (Sonarr no da calidad en su lista); en Películas sale de la calidad del archivo de Radarr.' },
  { pr: 'PR 5 (modal → panel + filas al estilo del prototipo) ⬜', text: 'buscar releases pasa del modal al panel de detalle; de momento el modal sigue abriéndose desde la lista y el calendario.' },
  { pr: 'PR 6 (retirar menús) ⬜', text: 'Archivos entra como pestaña del panel; Faltantes y Calendario se retiran del menú.' },
]

const PANEL_EMPTY = 'Selecciona un elemento de la lista para ver su detalle.'
const PANEL_NOTE =
  'Buscar releases aún se abre como modal, también desde el calendario; en el PR 5 pasa a este panel de detalle, junto con escanear y pedir descargas.'

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
                  onClick={() => onSelect({ id: series.id, detail: calidadSeriesDetail(series, folders) })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect({ id: series.id, detail: calidadSeriesDetail(series, folders) })
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

export function Series() {
  const [view, setView] = useState<SubView>('biblioteca')
  const [selected, setSelected] = useState<MediaSelection | null>(null)
  const uid = useId()
  const active = SUB_VIEWS.find((s) => s.id === view) ?? SUB_VIEWS[0]

  function changeView(next: SubView) {
    setView(next)
    // The selection belongs to the list it came from: a switch resets it.
    setSelected(null)
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
            <div className="wanted">
              <MediaPane
                kind="episodes"
                namespace="series"
                filter={view === 'biblioteca' ? 'all' : 'missing'}
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
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
              <button key={t} type="button" className="sec-dtab" disabled>
                {t}
              </button>
            ))}
          </div>

          {!selected && (
            <p className="sec-empty sec-empty-detail">{PANEL_EMPTY}</p>
          )}
          <p className="sec-panel-note">{PANEL_NOTE}</p>

          <div className="sec-action">
            <h4>Acción principal</h4>

            <span className="sec-field-label" id={`${uid}-quality`}>
              Calidad (enrutado automático)
            </span>
            <div className="sec-quality-row" role="group" aria-labelledby={`${uid}-quality`}>
              {QUALITIES.map((q) => (
                <button key={q} type="button" className="sec-q-chip" disabled>
                  {q}
                </button>
              ))}
            </div>

            <label className="sec-field-label" htmlFor={`${uid}-destino`}>
              Carpeta de destino
            </label>
            <select id={`${uid}-destino`} className="sec-destino" disabled defaultValue="">
              <option value="">— sin selección —</option>
            </select>

            <div className="sec-actions-row">
              <button type="button" className="sec-btn primary" disabled>
                Descargar en esta carpeta
              </button>
              <button type="button" className="sec-btn" disabled>
                Buscar otra vez
              </button>
            </div>

            <p className="sec-action-hint">
              Los controles de este panel se activan en el PR 5, cuando la acción
              principal pase a vivir aquí junto a las acciones de la fila.
            </p>
          </div>
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
