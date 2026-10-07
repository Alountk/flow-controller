import { useEffect, useMemo, useState } from 'react'
import type { PrototypeFile, PrototypeStatus } from '../types'
import './Prototypes.css'
import { apiFetch } from '../api/auth'

/**
 * The gallery, not just a tab strip.
 *
 * Eleven flat tabs answer none of the questions that brought someone here:
 * which of these was chosen, which were thrown away and why, and which one
 * should I look at first. The status comes from `prototypes/manifest.json`
 * and is **optional on purpose** — the backend annotates a directory listing,
 * it does not gate it, so an uncatalogued file still shows as `unlisted`
 * rather than disappearing.
 */

type Filter = 'all' | 'selected' | 'discarded' | 'candidate' | 'unlisted'

const STATUS_LABEL: Record<PrototypeStatus, string> = {
  selected: 'Elegido',
  discarded: 'Descartado',
  candidate: 'En liza',
  unlisted: 'Sin catalogar',
}

const SECTION_LABEL: Record<string, string> = {
  setup: 'Asistente de configuración',
  landing: 'Landing',
  peliculas: 'Películas',
  series: 'Series',
  seguimiento: 'Seguimiento',
  otros: 'Sin sección',
}

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'selected', label: 'Elegidos' },
  { id: 'discarded', label: 'Descartados' },
  { id: 'candidate', label: 'En liza' },
  { id: 'unlisted', label: 'Sin catalogar' },
]

/** Order sections so the new proposals sit together, not alphabetically. */
const SECTION_ORDER = ['peliculas', 'series', 'seguimiento', 'setup', 'landing', 'otros']

export function Prototypes() {
  const [prototypes, setPrototypes] = useState<PrototypeFile[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    apiFetch('/api/prototypes', {})
      .then((r) => r.json())
      .then((data: PrototypeFile[]) => {
        if (!active) return
        setPrototypes(data)
        if (data.length > 0) setSelected((current) => current ?? data[0].file)
      })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const visible = useMemo(
    () => (filter === 'all' ? prototypes : prototypes.filter((p) => p.status === filter)),
    [prototypes, filter],
  )

  const sections = useMemo(() => {
    const grouped = new Map<string, PrototypeFile[]>()
    for (const p of visible) {
      const bucket = grouped.get(p.section)
      if (bucket) bucket.push(p)
      else grouped.set(p.section, [p])
    }
    return [...grouped.entries()].sort(
      ([a], [b]) => SECTION_ORDER.indexOf(a) - SECTION_ORDER.indexOf(b),
    )
  }, [visible])

  const counts = useMemo(() => {
    const tally: Record<string, number> = { all: prototypes.length }
    for (const p of prototypes) tally[p.status] = (tally[p.status] ?? 0) + 1
    return tally
  }, [prototypes])

  if (loading) {
    return <div className="proto-loading">Cargando prototipos…</div>
  }

  if (prototypes.length === 0) {
    return (
      <div className="proto-empty">
        No hay prototipos en <code>prototypes/</code>.<br />
        Crea un archivo <code>.html</code> para que aparezca aquí.
      </div>
    )
  }

  return (
    <div className="proto">
      <div className="proto-head">
        <h2>Prototipos de diseño</h2>
        <p className="proto-sub">
          Previsualización de mockups HTML. Marca lo elegido y lo descartado en{' '}
          <code>prototypes/manifest.json</code>; estos archivos no son funcionales.
        </p>
      </div>

      <div className="proto-filters" role="tablist" aria-label="Filtrar por estado">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={`proto-filter ${filter === f.id ? 'active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            <span className="proto-count">{counts[f.id] ?? 0}</span>
          </button>
        ))}
      </div>

      {sections.length === 0 ? (
        <div className="proto-empty">
          Ningún prototipo tiene ese estado todavía.
        </div>
      ) : (
        sections.map(([section, items]) => (
          <section key={section} className="proto-section">
            <h3 className="proto-section-title">{SECTION_LABEL[section] ?? section}</h3>
            <div className="proto-grid">
              {items.map((p) => (
                <button
                  key={p.file}
                  type="button"
                  className={`proto-card ${p.status} ${selected === p.file ? 'active' : ''}`}
                  onClick={() => setSelected(p.file)}
                  aria-pressed={selected === p.file}
                >
                  <span className="proto-card-badges">
                    <span className={`proto-badge ${p.status}`}>{STATUS_LABEL[p.status]}</span>
                    {p.recommend && (
                      <span className="proto-badge recommend">★ Recomendado</span>
                    )}
                  </span>
                  <span className="proto-card-name">{p.name}</span>
                  {p.note && <span className="proto-card-note">{p.note}</span>}
                </button>
              ))}
            </div>
          </section>
        ))
      )}

      {selected && (
        <div className="proto-frame-wrap">
          <div className="proto-frame-label">
            {prototypes.find((p) => p.file === selected)?.name ?? selected}
          </div>
          <iframe
            key={selected}
            src={`/prototypes/${selected}`}
            className="proto-frame"
            title={selected}
          />
        </div>
      )}
    </div>
  )
}
