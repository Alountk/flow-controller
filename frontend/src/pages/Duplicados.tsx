import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  deleteDuplicate,
  fetchDuplicates,
  formatBytes,
  type DuplicateTitleGroup,
} from '../shared/api/duplicates'
import { fetchRoots } from '../shared/api/files.ts'
import './Duplicados.css'

/**
 * Duplicados: dos ficheros de vídeo en la misma carpeta, de la misma clase,
 * agrupados por película.
 *
 * La lista sale de recorrer el disco, así que **no se busca al montar**: son
 * miles de carpetas y el usuario entra a mirar, no a esperar. El alcance se
 * elige (una raíz y una subcarpeta) y se recuerda: la biblioteca entera tarda
 * minutos y casi siempre se sospecha de una parte.
 *
 * Radarr sólo guarda un `movieFile` por película, así que el fichero marcado es
 * el suyo y el otro es el que sobra. Borrar el marcado deja la película como
 * faltante en el arr: la confirmación lo dice en vez de esconderlo.
 */

const SCOPE_KEY = 'duplicados.scope'

function storedScope(): string {
  try {
    return window.localStorage.getItem(SCOPE_KEY) ?? ''
  } catch {
    return ''
  }
}

function rememberScope(path: string) {
  try {
    window.localStorage.setItem(SCOPE_KEY, path)
  } catch {
    // Un navegador sin almacenamiento no puede recordar nada: no es un error.
  }
}

/** The root `path` lives under, or '' when it lives under none of them. */
function rootOf(path: string, roots: string[]): string {
  return roots.find((root) => path === root || path.startsWith(`${root.replace(/\/+$/, '')}/`)) ?? ''
}

/** After a delete, a movie stops being a duplicate of itself. */
function withoutFile(group: DuplicateTitleGroup, path: string): DuplicateTitleGroup | null {
  const files = group.files.filter((file) => file.path !== path)
  const counts = new Map<string, number>()
  for (const file of files) counts.set(file.class, (counts.get(file.class) ?? 0) + 1)
  const repeated = new Set([...counts].filter(([, n]) => n > 1).map(([label]) => label))
  const kept = files.filter((file) => repeated.has(file.class))
  if (kept.length < 2) return null
  return {
    ...group,
    files: kept,
    classes: [...new Set(kept.map((file) => file.class))],
    reclaimable: kept.filter((file) => file.known === false).reduce((sum, file) => sum + file.size, 0),
  }
}

export default function Duplicados() {
  const [groups, setGroups] = useState<DuplicateTitleGroup[] | null>(null)
  const [radarrDown, setRadarrDown] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirming, setConfirming] = useState<string>('')
  const [deleting, setDeleting] = useState(false)
  const [scope, setScope] = useState<string>(storedScope)

  const rootsQuery = useQuery({
    queryKey: ['roots'],
    queryFn: fetchRoots,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  })
  const rootPaths = useMemo(
    () => (rootsQuery.data?.roots ?? []).map((root) => root.path),
    [rootsQuery.data],
  )
  const base = rootOf(scope, rootPaths)
  const segments = base ? scope.slice(base.replace(/\/+$/, '').length).split('/').filter(Boolean) : []

  useEffect(() => {
    rememberScope(scope)
  }, [scope])

  const search = async () => {
    setSearching(true)
    setError('')
    setNotice('')
    try {
      const body = await fetchDuplicates(scope || undefined)
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

  const remove = async (group: DuplicateTitleGroup, path: string) => {
    setDeleting(true)
    setError('')
    setNotice('')
    try {
      const result = await deleteDuplicate(path)
      setNotice(`Borrado: ${result.deleted}`)
      setConfirming('')
      // Un grupo que deja de repetir clase ya no es un duplicado: se cae de la
      // lista sin volver a recorrer el disco entero.
      setGroups((current) =>
        (current ?? [])
          .map((candidate) => (candidate.folder === group.folder ? withoutFile(candidate, path) : candidate))
          .filter((candidate): candidate is DuplicateTitleGroup => candidate !== null),
      )
    } catch (exc) {
      setError((exc as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  const reclaimable = (groups ?? []).reduce((sum, group) => sum + group.reclaimable, 0)
  const copyCount = (groups ?? []).reduce((sum, group) => sum + group.files.length, 0)

  return (
    <div className="duplicados">
      <header className="duplicados-header">
        <div>
          <h1 className="duplicados-title">Duplicados</h1>
          <p className="duplicados-subtitle">Carpetas con más de un vídeo de la misma clase</p>
        </div>
        <div className="duplicados-header-actions">
          <button
            type="button"
            className="duplicados-refresh"
            disabled={searching}
            onClick={() => void search()}
          >
            {searching ? 'Recorriendo…' : groups === null ? 'Buscar duplicados' : 'Buscar otra vez'}
          </button>
        </div>
      </header>

      <div className="duplicados-scope">
        <label className="duplicados-scope-label" htmlFor="duplicados-root">
          Buscar en
        </label>
        <select
          id="duplicados-root"
          className="duplicados-scope-select"
          value={base}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="">Todas las raíces</option>
          {rootPaths.map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
        </select>
        <span className="duplicados-breadcrumb" title={scope || 'Todas las raíces'}>
          {segments.length === 0 ? base || 'Todas las raíces' : `${base} › ${segments.join(' › ')}`}
        </span>
        <button
          type="button"
          className="duplicados-scope-btn"
          disabled={!scope}
          onClick={() => setScope(base)}
        >
          Subir
        </button>
        <button type="button" className="duplicados-scope-btn" onClick={() => setScope('')}>
          Raíz
        </button>
        <span className="duplicados-scope-note">Se recuerda para la próxima búsqueda</span>
      </div>

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
          Todavía no se ha buscado nada: elige dónde mirar y pulsa «Buscar duplicados». No lo
          hago solo porque son miles de carpetas.
        </p>
      )}

      {!searching && groups !== null && groups.length === 0 && (
        <p className="duplicados-empty">
          Ninguna carpeta repite fichero. Un 4K y un 1080p de la misma película no cuentan: son
          dos copias que quieres conservar.
        </p>
      )}

      {!searching && radarrDown && (
        <p className="duplicados-alert" role="alert">
          Radarr no respondió: no puedo decirte cuál de los dos ficheros es el que él conoce, así
          que ninguno está marcado como sobrante. Míralo tú antes de borrar, o vuelve a buscar
          cuando el arr esté en pie.
        </p>
      )}

      {!searching && groups !== null && groups.length > 0 && (
        <p className="duplicados-summary">
          {groups.length} {groups.length === 1 ? 'título' : 'títulos'} con duplicados · {copyCount}{' '}
          {copyCount === 1 ? 'copia' : 'copias'}
          {reclaimable > 0 && <> · {formatBytes(reclaimable)} recuperables</>}.
        </p>
      )}

      {(searching ? [] : groups ?? []).map((group) => (
        <section className="duplicados-group" key={group.folder}>
          <header className="duplicados-group-header">
            <div>
              <h2 className="duplicados-group-title">{group.title}</h2>
              <p className="duplicados-folder" title={group.folder}>
                {group.folder}
              </p>
            </div>
            <div className="duplicados-group-meta">
              <span className="duplicados-chip">
                {group.files.length} {group.files.length === 1 ? 'copia' : 'copias'}
              </span>
              {group.classes.map((label) => (
                <span className="duplicados-chip" key={label}>
                  {label}
                </span>
              ))}
              {group.reclaimable > 0 && (
                <span className="duplicados-chip is-reclaim">{formatBytes(group.reclaimable)}</span>
              )}
            </div>
          </header>

          {radarrDown && (
            <p className="duplicados-group-warn">
              Radarr no respondió: no se puede afirmar cuál sobra. Sólo se listan las copias.
            </p>
          )}

          <ul className="duplicados-files">
            {group.files.map((file) => (
              <li className="duplicados-file" key={file.path}>
                <span className="duplicados-path" title={file.path}>
                  {file.name}
                </span>
                <span className="duplicados-class">{file.class}</span>
                <span className="duplicados-size">{formatBytes(file.size)}</span>
                <span
                  className={
                    file.known === true
                      ? 'duplicados-known'
                      : file.known === false
                        ? 'duplicados-extra'
                        : 'duplicados-unknown'
                  }
                  title={
                    file.known === true
                      ? 'Radarr tiene este fichero en su catálogo'
                      : file.known === false
                        ? 'Radarr no tiene este fichero: borrarlo no toca el catálogo'
                        : 'Sin datos de Radarr: no se sabe cuál es el suyo'
                  }
                >
                  {file.known === true ? 'en el catálogo' : file.known === false ? 'sobra' : 'sin datos'}
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
