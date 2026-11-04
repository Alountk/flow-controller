import { useState } from 'react'
import {
  deleteDuplicate,
  fetchDuplicates,
  formatBytes,
  type DuplicateGroup,
} from '../shared/api/duplicates'
import './Duplicados.css'

/**
 * Duplicados: dos ficheros de vídeo en la misma carpeta, de la misma clase.
 *
 * La lista sale de recorrer el disco, así que **no se busca al montar**: son
 * miles de carpetas y el usuario entra a mirar, no a esperar. El botón es el
 * disparo, y el aviso de que tarda es honesto.
 *
 * Radarr sólo guarda un `movieFile` por película, así que el fichero marcado es
 * el suyo y el otro es el que sobra. Borrar el marcado deja la película como
 * faltante en el arr: la confirmación lo dice en vez de esconderlo.
 */
export default function Duplicados() {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null)
  const [radarrDown, setRadarrDown] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirming, setConfirming] = useState<string>('')
  const [deleting, setDeleting] = useState(false)

  const search = async () => {
    setSearching(true)
    setError('')
    setNotice('')
    try {
      const body = await fetchDuplicates()
      // La forma del payload no se da por hecha: un backend viejo o un proxy que
      // devuelve HTML tumbaba la vista entera (la lección de `services.qbit.url`).
      setGroups(Array.isArray(body?.groups) ? body.groups : [])
      setRadarrDown(body?.radarr === false)
      if (body?.error) setError(body.error)
    } catch (exc) {
      setError((exc as Error).message)
    } finally {
      setSearching(false)
    }
  }

  const remove = async (group: DuplicateGroup, path: string) => {
    setDeleting(true)
    setError('')
    setNotice('')
    try {
      const result = await deleteDuplicate(path)
      setNotice(`Borrado: ${result.deleted}`)
      setConfirming('')
      // Una carpeta con un solo fichero ya no es un duplicado: se cae de la lista
      // sin volver a recorrer el disco entero.
      setGroups((current) => (current ?? [])
        .map((g) => (g.folder === group.folder
          ? { ...g, files: g.files.filter((f) => f.path !== path) }
          : g))
        .filter((g) => g.files.length > 1))
    } catch (exc) {
      setError((exc as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  const reclaimable = (groups ?? []).reduce((sum, g) => sum + g.reclaimable, 0)

  return (
    <div className="duplicados">
      <header className="duplicados-header">
        <div>
          <h1 className="duplicados-title">Duplicados</h1>
          <p className="duplicados-subtitle">
            Dos ficheros de la misma película y la misma calidad en una carpeta.
          </p>
        </div>
        <button
          type="button"
          className="duplicados-refresh"
          disabled={searching}
          onClick={() => void search()}
        >
          {searching ? 'Recorriendo…' : groups === null ? 'Buscar duplicados' : 'Buscar otra vez'}
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

      {searching && (
        <p className="duplicados-empty" role="status">
          Recorriendo la biblioteca. En un disco grande esto tarda minutos.
        </p>
      )}

      {!searching && groups === null && !error && (
        <p className="duplicados-empty">
          Todavía no se ha buscado nada: pulsa «Buscar duplicados» y recorro la
          biblioteca. No lo hago solo porque son miles de carpetas.
        </p>
      )}

      {!searching && groups !== null && groups.length === 0 && (
        <p className="duplicados-empty">
          Ninguna carpeta repite fichero. Un 4K y un 1080p de la misma película no
          cuentan: son dos copias que quieres conservar.
        </p>
      )}

      {!searching && radarrDown && (
        <p className="duplicados-alert" role="alert">
          Radarr no respondió: no puedo decirte cuál de los dos ficheros es el que
          él conoce, así que ninguno está marcado como sobrante. Míralo tú antes de
          borrar, o vuelve a buscar cuando el arr esté en pie.
        </p>
      )}

      {!searching && groups !== null && groups.length > 0 && (
        <p className="duplicados-summary">
          {groups.length} {groups.length === 1 ? 'carpeta' : 'carpetas'}
          {reclaimable > 0 && <> · {formatBytes(reclaimable)} reclamables borrando sólo lo que Radarr no conoce</>}
          .
        </p>
      )}

      {(searching ? [] : groups ?? []).map((group) => (
        <section className="duplicados-group" key={`${group.folder}-${group.class}`}>
          <header className="duplicados-group-header">
            <h2 className="duplicados-group-title">{group.title}</h2>
            <span className="duplicados-chip">{group.class}</span>
            <span className="duplicados-count">{group.files.length} ficheros</span>
          </header>
          <p className="duplicados-folder">{group.folder}</p>
          <ul className="duplicados-files">
            {group.files.map((file) => (
              <li className="duplicados-file" key={file.path}>
                <span className="duplicados-path" title={file.path}>
                  {file.name}
                </span>
                <span className="duplicados-size">{formatBytes(file.size)}</span>
                <span
                  className={file.known === true ? 'duplicados-known'
                    : file.known === false ? 'duplicados-extra' : 'duplicados-unknown'}
                  title={file.known === true
                    ? 'Radarr tiene este fichero en su catálogo'
                    : file.known === false
                      ? 'Radarr no tiene este fichero: borrarlo no toca el catálogo'
                      : 'Sin datos de Radarr: no se sabe cuál es el suyo'}
                >
                  {file.known === true ? 'Radarr' : file.known === false ? 'sobra' : 'sin datos'}
                </span>
                {confirming === file.path ? (
                  <span className="duplicados-confirm">
                    <span className="duplicados-question">
                      {file.known === true
                        ? '¿Borrar el que Radarr conoce? Lo marcará como faltante.'
                        : '¿Borrar este fichero?'}
                    </span>
                    <button
                      type="button"
                      className="duplicados-danger"
                      disabled={deleting}
                      onClick={() => void remove(group, file.path)}
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
