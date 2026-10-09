/** "Carpetas compartidas de aMule" — the Configuración panel for them.
 *
 * Lives in its own file rather than inside `Settings` because it is not part
 * of the settings form: it reads and writes aMule's own configuration and
 * takes effect on save (a reload follows), where the form only takes effect
 * on "Guardar configuración". Mixing them would make one button claim to
 * save the other's work.
 */

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchSharedDirs,
  saveSharedDirs,
  type SharedDirsSaveResult,
} from '../../shared/api/amuleShares.ts'
import './Settings.css'

export function SharedDirsSection() {
  const queryClient = useQueryClient()
  const [recursive, setRecursive] = useState<string[]>([])
  const [explicit, setExplicit] = useState<string[]>([])
  const [entry, setEntry] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const query = useQuery({ queryKey: ['amule-shared-dirs'], queryFn: fetchSharedDirs })

  useEffect(() => {
    // `?? []` because a settings-page fixture that mocks `fetch` answers this
    // endpoint with `{}`, and rendering a list of undefined would take the
    // whole page down over a panel that merely has nothing to show.
    if (query.data) {
      setRecursive(query.data.recursive ?? [])
      setExplicit(query.data.explicit ?? [])
    }
  }, [query.data])

  const save = useMutation({
    mutationFn: () => saveSharedDirs({ recursive, explicit }),
    onSuccess: (result: SharedDirsSaveResult) => {
      setNotice(
        result.ok
          ? 'Guardado y recargado en aMule.'
          : `Guardado, pero la recarga falló: ${result.reload.detail}`,
      )
      queryClient.invalidateQueries({ queryKey: ['amule-shared-dirs'] })
    },
    onError: (error: Error) => setNotice(`No se pudo guardar: ${error.message}`),
  })

  // The form renders only once the query has settled, so this is always the
  // value the endpoint reported — the same authority the backend enforces.
  const roots = query.data?.allowed_roots ?? []

  function addTo(list: 'recursive' | 'explicit') {
    const path = entry.trim().replace(/\/+$/, '')
    setNotice(null)
    if (!path.startsWith('/')) {
      setNotice('La ruta debe ser absoluta (empezar por /).')
      return
    }
    const inside = roots.some((r) => path === r.replace(/\/+$/, '') || path.startsWith(`${r.replace(/\/+$/, '')}/`))
    if (!inside) {
      setNotice(`Fuera de las raíces permitidas: ${path}`)
      return
    }
    const setter = list === 'recursive' ? setRecursive : setExplicit
    setter((current) => (current.includes(path) ? current : [...current, path]))
    setEntry('')
  }

  function Row({ path, onRemove }: { path: string; onRemove: () => void }) {
    return (
      <li className="shared-dirs-row">
        <code>{path}</code>
        <button className="action-btn" onClick={onRemove} type="button">
          Quitar
        </button>
      </li>
    )
  }

  if (query.isPending) return <div className="settings-section">Cargando carpetas compartidas…</div>
  if (query.error) {
    return (
      <div className="settings-section">
        <div className="error-box">No se pudo leer la configuración de aMule.</div>
      </div>
    )
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Carpetas compartidas de aMule</h3>
      <p className="shared-dirs-hint">
        Guardar escribe la configuración de aMule y <strong>pide que recargue</strong>: el cambio
        no es efectivo hasta que aMule lo recoja. Solo se puede compartir dentro de{' '}
        <code>allowed_roots</code>.
      </p>

      <div className="settings-field">
        <label className="settings-label" htmlFor="shared-dirs-entry">
          Ruta a compartir
        </label>
        <div className="shared-dirs-add">
          <input
            id="shared-dirs-entry"
            className="settings-input"
            value={entry}
            placeholder="/mnt/storage/peliculas"
            onChange={(e) => setEntry(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addTo('recursive')
            }}
          />
          <button className="action-btn" type="button" onClick={() => addTo('recursive')}>
            Añadir recursiva
          </button>
          <button className="action-btn" type="button" onClick={() => addTo('explicit')}>
            Añadir solo esta carpeta
          </button>
        </div>
      </div>

      <div className="settings-group">
        <h4>Recursivas (comparte también las subcarpetas)</h4>
        {recursive.length === 0 ? (
          <div className="shared-dirs-empty">Ninguna — aMule no está compartiendo nada.</div>
        ) : (
          <ul className="shared-dirs-list">
            {recursive.map((path) => (
              <Row key={path} path={path} onRemove={() => setRecursive((c) => c.filter((p) => p !== path))} />
            ))}
          </ul>
        )}
      </div>

      <div className="settings-group">
        <h4>Solo esta carpeta (no baja a subcarpetas)</h4>
        {explicit.length === 0 ? (
          <div className="shared-dirs-empty">Ninguna.</div>
        ) : (
          <ul className="shared-dirs-list">
            {explicit.map((path) => (
              <Row key={path} path={path} onRemove={() => setExplicit((c) => c.filter((p) => p !== path))} />
            ))}
          </ul>
        )}
      </div>

      <div className="settings-logs-controls">
        <button
          className="action-btn search-all"
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Guardando…' : '💾 Guardar y recargar aMule'}
        </button>
        <span className="shared-dirs-notice" role="status">
          {notice}
        </span>
      </div>

      <p className="shared-dirs-hint">
        Configuración de aMule: <code>{query.data?.config_dir}</code>
      </p>
    </div>
  )
}
