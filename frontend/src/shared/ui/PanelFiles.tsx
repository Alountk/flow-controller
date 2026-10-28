import { formatSize, useBrowse } from '../hooks/useFilesNavigator.ts'
import { errorMessage } from '../utils/text.ts'
import type { BrowseResponse } from '../types.ts'

/** What the Archivos tab reads of each page's RowFacts — pages pass theirs. */
export type PanelFilesFacts =
  | { state: 'empty' }
  | { state: 'missing' }
  | { state: 'ready'; path: string | null }

// Also rendered by the Historial and Episodios panels — the one copy.
export const ROW_MISSING = 'No se pudo leer la fila seleccionada.'

/** The Archivos tab: the selected row's folder, read-only by construction —
 *  rename/delete/copy live in the Archivos PAGE (retired later, not here). */
export function PanelFiles({ facts }: { facts: PanelFilesFacts }) {
  if (facts.state === 'empty') return null
  if (facts.state === 'missing') return <p className="sec-tab-note">{ROW_MISSING}</p>
  if (!facts.path) return <p className="sec-tab-note">Esta entrada no tiene ruta</p>
  return <FilesList path={facts.path} />
}

function FilesList({ path }: { path: string }) {
  const query = useBrowse(path, true)
  if (query.isPending) return <p className="sec-tab-note">Cargando ruta…</p>
  if (query.isError) {
    return (
      <div className="wanted-error" role="alert">
        <strong>No se pudo leer la ruta</strong>
        <span>{errorMessage(query.error)}</span>
      </div>
    )
  }
  // browsePath answers failures on the body ("No es un directorio", FastAPI's
  // `detail`) — neither may render as an empty listing.
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
