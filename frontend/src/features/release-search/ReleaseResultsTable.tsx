import { useState } from 'react'
import { formatSize } from '../../shared/hooks/useFilesNavigator.ts'
import { nextSort, sortReleases, type SortKey, type SortState } from '../../shared/utils/releaseTable.ts'

/** The facts the table needs from a release; the modal owns everything else. */
export interface ReleaseRow {
  guid: string
  title: string
  indexer?: string
  source?: string
  size: number
  languages?: string[]
  seeders?: number
}

export interface ReleaseTableActions {
  isProcessing: boolean
  path4k: string
  path3d: string
  /** The value `destinationFor` returns for «the arr library» — compared only,
   *  never printed: the button says 1080 (S2). */
  libraryValue: string
  destinationFor: (r: ReleaseRow) => string
  isThreeD: (r: ReleaseRow) => boolean
  onToggleThreeD: (guid: string) => void
  onGrab: (guid: string, target: 'library' | '4k' | '3d') => void
  onPickFolder: (guid: string) => void
}

const COLUMNS: Array<{ key: SortKey | null; label: string; numeric?: boolean }> = [
  { key: 'name', label: 'Nombre' },
  { key: 'size', label: 'Tamaño', numeric: true },
  { key: 'language', label: 'Idioma' },
  { key: 'seeders', label: 'Seeders', numeric: true },
  { key: null, label: 'Destino' },
]

/** One row's provenance label — the indexer when it has one (aMule rows name
 *  their source instead). S4: it stays visible, as a badge under the name. */
function sourceLabel(r: ReleaseRow): string {
  return r.indexer || r.source || 'Desconocido'
}

export function ReleaseResultsTable({
  releases,
  actions,
}: {
  releases: ReleaseRow[]
  actions: ReleaseTableActions
}) {
  const [sort, setSort] = useState<SortState>({ key: null, dir: 'asc' })
  const rows = sortReleases(releases, sort)
  const ariaSort = (key: SortKey | null) => {
    if (!key || sort.key !== key) return 'none' as const
    return sort.dir === 'asc' ? ('ascending' as const) : ('descending' as const)
  }

  return (
    <div className="release-table-wrap">
      <table className="release-table">
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th
                key={column.label}
                scope="col"
                aria-sort={ariaSort(column.key)}
                className={column.numeric ? 'is-numeric' : undefined}
              >
                {column.key ? (
                  <button
                    type="button"
                    className="release-sort"
                    onClick={() => setSort((prev) => nextSort(prev, column.key as SortKey))}
                  >
                    {column.label}
                    {sort.key === column.key && (
                      <span aria-hidden="true">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>
                    )}
                  </button>
                ) : (
                  column.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.guid}>
              <td className="release-title-cell">
                <span className="release-title">{r.title}</span>
                <span className="release-source">{sourceLabel(r)}</span>
              </td>
              <td className="is-numeric">{formatSize(r.size)}</td>
              <td>
                {(r.languages ?? []).length > 0 ? (
                  (r.languages ?? []).map((language) => (
                    <span key={language} className="release-lang">
                      {language}
                    </span>
                  ))
                ) : (
                  <span className="release-unknown">—</span>
                )}
              </td>
              <td className="is-numeric">
                {typeof r.seeders === 'number' ? (
                  <span className={`release-seeders ${seederClass(r.seeders)}`}>⬆ {r.seeders}</span>
                ) : (
                  <span className="release-unknown">—</span>
                )}
              </td>
              <td>
                <div className="release-dest">
                  <button
                    type="button"
                    className={`release-dest-btn ${actions.destinationFor(r) === actions.libraryValue ? 'suggest' : ''}`}
                    onClick={() => actions.onGrab(r.guid, 'library')}
                    disabled={actions.isProcessing}
                    title="1080 (la biblioteca del arr)"
                  >
                    → 1080
                  </button>
                  <button
                    type="button"
                    className={`release-dest-btn ${actions.path4k && actions.destinationFor(r) === actions.path4k ? 'suggest' : ''}`}
                    onClick={() => actions.onGrab(r.guid, '4k')}
                    disabled={actions.isProcessing || !actions.path4k}
                    title={actions.path4k || '4K sin configurar'}
                  >
                    → 4K
                  </button>
                  <button
                    type="button"
                    className={`release-dest-btn ${actions.path3d && actions.destinationFor(r) === actions.path3d ? 'suggest' : ''}`}
                    onClick={() => actions.onGrab(r.guid, '3d')}
                    disabled={actions.isProcessing || !actions.path3d}
                    title={actions.path3d || '3D sin configurar'}
                  >
                    → 3D
                  </button>
                  <button
                    type="button"
                    className="release-dest-btn"
                    onClick={() => actions.onPickFolder(r.guid)}
                    disabled={actions.isProcessing}
                  >
                    → Carpeta
                  </button>
                  <button
                    type="button"
                    className={`release-3d ${actions.isThreeD(r) ? 'active' : ''}`}
                    aria-pressed={actions.isThreeD(r)}
                    aria-label={
                      actions.isThreeD(r)
                        ? `Quitar la marca 3D de ${r.title}`
                        : `Marcar ${r.title} como 3D`
                    }
                    onClick={() => actions.onToggleThreeD(r.guid)}
                  >
                    3D
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Seeder colour scale: plenty, thin, dying — the operator triages by it. */
function seederClass(seeders: number): string {
  if (seeders >= 50) return 'is-good'
  if (seeders >= 10) return 'is-ok'
  return 'is-bad'
}
