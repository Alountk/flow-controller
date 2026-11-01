import { useQuery } from '@tanstack/react-query'
import { fetchQualityBelow } from '../../shared/api/quality.ts'
import { formatSize } from '../../shared/hooks/useFilesNavigator.ts'
import { errorMessage } from '../../shared/utils/text.ts'
import { RESOLUTION_LABELS } from '../../shared/utils/resolution.ts'

/**
 * S4 («umbral-calidad»): the library files measured below the threshold.
 *
 * Only measured files can appear here — the un-analyzed count sits beside the
 * list on purpose, so «no hay candidatas» never hides a library nobody swept.
 */
export function QualityBelowList() {
  const query = useQuery({
    queryKey: ['quality-below'],
    queryFn: fetchQualityBelow,
    staleTime: 0,
  })

  if (query.isPending) return <p className="sec-tab-note">Leyendo la biblioteca…</p>
  if (query.isError) {
    return (
      <div className="wanted-error" role="alert">
        <strong>No se pudo leer la calidad de la biblioteca</strong>
        <span>{errorMessage(query.error)}</span>
      </div>
    )
  }

  const report = query.data
  const thresholdLabel = RESOLUTION_LABELS[report.threshold.min_class] ?? report.threshold.min_class
  const limit = report.threshold.min_width > 0
    ? `por debajo de ${report.threshold.min_width}px`
    : `por debajo de ${thresholdLabel}`

  return (
    <section className="sec-quality-below">
      <h3>
        {report.items.length} {limit}
      </h3>
      <p className="sec-tab-note">
        {report.analyzed} analizados · {report.unanalyzed} sin analizar
      </p>
      <p className="sec-analyze-row">
        <button type="button" className="sec-analyze" onClick={() => void query.refetch()}>
          Actualizar
        </button>
      </p>
      {report.items.length === 0 ? (
        <p className="sec-tab-note">Ninguna película medida está por debajo del umbral.</p>
      ) : (
        <table className="sec-table sec-files-table">
          <thead>
            <tr>
              <th scope="col">Archivo</th>
              <th scope="col">Resolución</th>
              <th scope="col">Clase</th>
              <th scope="col">Tamaño</th>
            </tr>
          </thead>
          <tbody>
            {report.items.map((item) => (
              <tr key={item.path}>
                <td className="sec-file-name" title={item.path}>{item.name}</td>
                <td>{item.width}×{item.height}</td>
                <td>{RESOLUTION_LABELS[item.class] ?? item.class}</td>
                <td>{formatSize(item.size_bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
