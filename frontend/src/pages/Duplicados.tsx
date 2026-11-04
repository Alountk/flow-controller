import { useCallback, useEffect, useState } from 'react'
import {
  deleteDuplicate,
  fetchDuplicates,
  formatBytes,
  type DuplicateGroup,
} from '../shared/api/duplicates'
import './Duplicados.css'

/**
 * Buscador de películas duplicadas.
 *
 * La lista sale de lo que Radarr ya sabe: entrar aquí no recorre la biblioteca.
 * El disco sólo se toca al borrar, y borrar es irreversible — por eso pide
 * confirmación en la propia fila y enseña el motivo cuando el backend se niega.
 */
export default function Duplicados() {
  const [groups, setGroups] = useState<DuplicateGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirming, setConfirming] = useState<string>('')
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const body = await fetchDuplicates(signal)
      if (signal?.aborted) return
      // La forma del payload no se da por hecha: un backend viejo o un proxy que
      // devuelve HTML tumbaba la vista entera (la lección de `services.qbit.url`).
      setGroups(Array.isArray(body?.groups) ? body.groups : [])
      if (body?.error) setError(body.error)
    } catch (exc) {
      if ((exc as Error).name === 'AbortError') return
      setError((exc as Error).message)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const remove = async (path: string) => {
    setDeleting(true)
    setError('')
    setNotice('')
    try {
      const result = await deleteDuplicate(path)
      setNotice(`Borrado: ${result.deleted}`)
      setConfirming('')
      await load()
    } catch (exc) {
      setError((exc as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="duplicados">
      <header className="duplicados-header">
        <div>
          <h1 className="duplicados-title">Duplicados</h1>
          <p className="duplicados-subtitle">
            La misma película, en la misma calidad, más de una vez en el disco.
          </p>
        </div>
        <button type="button" className="duplicados-refresh" onClick={() => void load()}>
          Actualizar
        </button>
      </header>

      {error && (
        <p className="duplicados-alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="duplicados-notice" role="status">
          {notice}
        </p>
      )}

      {loading && <p className="duplicados-empty">Buscando…</p>}

      {!loading && !error && groups.length === 0 && (
        <p className="duplicados-empty">
          Ningún duplicado. Un 4K y un 1080p de la misma película no cuentan.
        </p>
      )}

      {groups.map((group) => (
        <section className="duplicados-group" key={`${group.tmdb_id}-${group.class}`}>
          <header className="duplicados-group-header">
            <h2 className="duplicados-group-title">
              {group.titles[0] || `tmdb ${group.tmdb_id}`}
            </h2>
            <span className="duplicados-chip">{group.class}</span>
            <span className="duplicados-count">{group.files.length} ficheros</span>
          </header>
          {group.titles.length > 1 && (
            <p className="duplicados-titles">{group.titles.slice(1).join(' · ')}</p>
          )}
          <ul className="duplicados-files">
            {group.files.map((file) => (
              <li className="duplicados-file" key={file.path}>
                <span className="duplicados-path" title={file.path}>
                  {file.path}
                </span>
                <span className="duplicados-size">{formatBytes(file.size)}</span>
                {confirming === file.path ? (
                  <span className="duplicados-confirm">
                    <span className="duplicados-question">¿Borrar este fichero?</span>
                    <button
                      type="button"
                      className="duplicados-danger"
                      disabled={deleting}
                      onClick={() => void remove(file.path)}
                    >
                      Sí, borrar
                    </button>
                    <button type="button" onClick={() => setConfirming('')}>
                      Cancelar
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="duplicados-delete"
                    onClick={() => setConfirming(file.path)}
                  >
                    Borrar
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
