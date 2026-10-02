import { Fragment, useId, useState } from 'react'
import { MediaPane, type MediaSelection } from './MediaPane'
import './Sections.css'

/**
 * Series — master–detail (F-08).
 *
 * PR 2 of the plan: the sub-view tabs BECOME the filter. Biblioteca shows the
 * full catalogue and Faltantes the missing episodes — both rendered by
 * MediaPane, the component extracted from the Faltantes page — so the pane
 * must not draw a second set of filter controls here. Selecting a row fills
 * the detail panel with that row's own data; Estrenos and Calidad still wait
 * for PR 3. The twin of Películas: same model, different words.
 */

type SubView = 'biblioteca' | 'faltantes' | 'estrenos' | 'calidad'

interface SubViewDef {
  id: SubView
  label: string
  /** Only the sub-views PR 2 has not filled yet still carry an empty state. */
  empty?: string
}

const SUB_VIEWS: SubViewDef[] = [
  { id: 'biblioteca', label: 'Biblioteca' },
  { id: 'faltantes', label: 'Faltantes' },
  {
    id: 'estrenos',
    label: 'Estrenos',
    empty: 'Llega con el PR 3: se mueve desde Calendario, y el modal de releases pasa a panel de detalle.',
  },
  {
    id: 'calidad',
    label: 'Calidad',
    empty: 'Llega con el PR 3.',
  },
]

/** Sub-views whose list is live content (PR 2); the rest show their empty state. */
const LIVE_VIEWS: SubView[] = ['biblioteca', 'faltantes']

const COLUMNS = ['Título', 'Año', 'Estado', 'Calidad', 'Ruta']
const DETAIL_TABS = ['Episodios', 'Releases', 'Archivos']
const QUALITIES = ['1080p', '4K', '3D']

const NOTES: { pr: string; text: string }[] = [
  { pr: 'PR 1', text: 'techo: navegación, rutas y la envoltura maestro–detalle.' },
  { pr: 'PR 2 (este)', text: 'Biblioteca y Faltantes muestran las listas reales, extraídas de la sección Faltantes; la selección rellena el panel de detalle.' },
  { pr: 'PR 3', text: 'Estrenos desde Calendario, Calidad (4K/3D), y buscar releases, escanear y pedir pasan al panel de detalle.' },
  { pr: 'PR 4', text: 'Archivos entra como pestaña del panel; Faltantes y Calendario se retiran del menú.' },
]

const PANEL_EMPTY = 'Selecciona un elemento de la lista para ver su detalle.'
const PR3_NOTE =
  'Buscar releases, escanear y pedir descargas pasan a este panel en el PR 3; de momento siguen en cada fila.'

export function Series() {
  const [view, setView] = useState<SubView>('biblioteca')
  const [selected, setSelected] = useState<MediaSelection | null>(null)
  const uid = useId()
  const active = SUB_VIEWS.find((s) => s.id === view) ?? SUB_VIEWS[0]
  const live = LIVE_VIEWS.includes(view)

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

          {live ? (
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
          ) : (
            <table className="sec-table">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c} scope="col">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="sec-empty" colSpan={COLUMNS.length}>
                    {active.empty}
                  </td>
                </tr>
              </tbody>
            </table>
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
          <p className="sec-pr3-note">{PR3_NOTE}</p>

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
              Los controles de este panel se activan en el PR 3, cuando la acción
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
