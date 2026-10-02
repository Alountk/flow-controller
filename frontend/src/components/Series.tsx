import { useId, useState } from 'react'
import './Sections.css'

/**
 * PR 1 of the F-08 plan: navigation, routing and an empty shell that already
 * looks like the chosen master–detail prototype — the twin of Películas, same
 * model, different words. Nothing has moved yet, so every state says out loud
 * which PR brings the content it is waiting for.
 */

type SubView = 'biblioteca' | 'faltantes' | 'estrenos' | 'calidad'

interface SubViewDef {
  id: SubView
  label: string
  empty: string
}

const SUB_VIEWS: SubViewDef[] = [
  {
    id: 'biblioteca',
    label: 'Biblioteca',
    empty: 'Llega con el PR 2: la lista completa se mueve aquí desde Faltantes.',
  },
  {
    id: 'faltantes',
    label: 'Faltantes',
    empty: 'Llega con el PR 2: la cola de faltantes se mueve aquí desde Faltantes.',
  },
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

const COLUMNS = ['Título', 'Año', 'Estado', 'Calidad', 'Ruta']
const DETAIL_TABS = ['Episodios', 'Releases', 'Archivos']
const QUALITIES = ['1080p', '4K', '3D']

const NOTES: { pr: string; text: string }[] = [
  { pr: 'PR 1 (este)', text: 'techo: navegación, rutas y esta envoltura vacía. Nada se ha movido todavía.' },
  { pr: 'PR 2', text: 'Biblioteca y Faltantes: la lista se mueve desde la sección Faltantes.' },
  { pr: 'PR 3', text: 'Estrenos desde Calendario, Calidad (4K/3D) y el modal de releases pasa a panel de detalle.' },
  { pr: 'PR 4', text: 'Archivos entra como pestaña del panel; Faltantes y Calendario se retiran del menú.' },
]

export function Series() {
  const [view, setView] = useState<SubView>('biblioteca')
  const uid = useId()
  const active = SUB_VIEWS.find((s) => s.id === view) ?? SUB_VIEWS[0]

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
            onClick={() => setView(s.id)}
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
        </section>

        <section className="sec-detail" aria-label="Panel de detalle">
          <div className="sec-detail-head">
            <span className="sec-poster" aria-hidden="true" />
            <div className="sec-detail-titles">
              <h3>Sin selección</h3>
              <dl className="sec-meta">
                <dt>Año</dt>
                <dd>—</dd>
                <dt>Estado</dt>
                <dd>—</dd>
                <dt>Calidad</dt>
                <dd>—</dd>
                <dt>Ruta</dt>
                <dd>—</dd>
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

          <p className="sec-empty sec-empty-detail">
            Selecciona un elemento de la lista — la lista llega en el PR 2.
          </p>

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
              Los controles se activan al seleccionar un elemento de la lista.
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
