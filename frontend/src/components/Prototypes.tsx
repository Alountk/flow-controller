import { useEffect, useState } from 'react'
import type { PrototypeFile } from '../types'
import './Prototypes.css'
import { authHeaders } from '../api/auth'

export function Prototypes() {
  const [prototypes, setPrototypes] = useState<PrototypeFile[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    fetch('/api/prototypes', { headers: authHeaders() })
      .then((r) => r.json())
      .then((data: PrototypeFile[]) => {
        if (!active) return
        setPrototypes(data)
        if (data.length > 0 && !selected) setSelected(data[0].file)
      })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

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
          Previsualización de mockups HTML. Estos archivos no son funcionales.
        </p>
      </div>

      <div className="proto-tabs">
        {prototypes.map((p) => (
          <button
            key={p.file}
            className={`proto-tab ${selected === p.file ? 'active' : ''}`}
            onClick={() => setSelected(p.file)}
          >
            {p.name}
          </button>
        ))}
      </div>

      {selected && (
        <div className="proto-frame-wrap">
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
