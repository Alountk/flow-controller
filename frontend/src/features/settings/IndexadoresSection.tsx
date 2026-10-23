/** «Indexadores» — the direct-connections registry + unified search (T6/S5-S6).
 *
 * A standalone section like `SharedDirsSection`: it reads and writes its own
 * SQLite table and acts on its own buttons, so it is NOT part of the settings
 * form ("Guardar configuración" must never claim to have saved this). The
 * `<Section>` wrapper in `Settings.tsx` is module-private and the named mold
 * (`SharedDirsSection`) renders its own `settings-section` heading — this
 * follows the mold instead of reaching through a circular import.
 *
 * Contract notes the UI must honor (from `routes/indexers.py`):
 * - `api_key` arrives MASKED and an empty edit field means KEEP the stored
 *   key (placeholder «(sin cambio)» says so);
 * - «Probar» is a probe: caps inline on success, the Spanish `detail` inline
 *   on failure — never silence;
 * - the search fan-out may SKIP sources and every skip names itself and its
 *   reason («{fuente}: {razón}») — a silent empty is the one answer this
 *   feature refuses to give;
 * - «Descargar» calls `POST /api/indexers/download` with `link ?? guid` (the
 *   L6 amendment: `POST /api/calendar/grab` needs an arr service and ids the
 *   free rows do not have) and reports `ok`/`detail` as a toast — the repo's
 *   grab-outcome surface (F-13). The button is guarded with
 *   `onClick={pending ? undefined : fn}` because jsdom still fires clicks on
 *   disabled buttons.
 */

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  INDEXER_SOURCES,
  fetchIndexers,
  createIndexer,
  updateIndexer,
  deleteIndexer,
  testIndexer,
  searchIndexers,
  downloadIndexer,
  type IndexerRow,
  type IndexerInput,
  type IndexerCaps,
  type IndexerTestResult,
  type IndexerSearchRow,
  type IndexerSearchSource,
  type IndexerSearchResponse,
} from '../../shared/api/indexers.ts'
import { toast } from '../../shared/utils/toast.ts'
import './Settings.css'

/**
 * Mirror of `ReleaseSearchModal`'s `groupByIndexer` (module-private there —
 * not exported, and importing the modal would couple Settings to the
 * release-search feature). Same Map mechanics; the fallback key is the row's
 * SOURCE instead of «Desconocido»: a free-search row always knows its source
 * and naming it is honest where «Desconocido» would throw truth away.
 */
function groupByIndexer(rows: IndexerSearchRow[]): Map<string, IndexerSearchRow[]> {
  const map = new Map<string, IndexerSearchRow[]>()
  for (const row of rows) {
    const key = row.indexer || row.source
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(row)
  }
  return map
}

function formatSize(size: number | null): string {
  if (size == null) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function capsCategories(caps: IndexerCaps | undefined): string {
  const categories = caps?.categories
  if (!Array.isArray(categories) || categories.length === 0) return ''
  const names = categories.map((c) => c?.name).filter(Boolean)
  return names.length > 0 ? ` · Categorías: ${names.join(', ')}` : ''
}

const EMPTY_FORM = { name: '', url: '', api_key: '', categories: '' }

export function IndexadoresSection() {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<IndexerInput & typeof EMPTY_FORM>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null)
  const [testResults, setTestResults] = useState<Record<number, IndexerTestResult>>({})
  const [selectedSources, setSelectedSources] = useState<Set<IndexerSearchSource>>(
    new Set(INDEXER_SOURCES),
  )
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [search, setSearch] = useState<{
    response: IndexerSearchResponse
    searched: IndexerSearchSource[]
    filter: 'all' | IndexerSearchSource
  } | null>(null)
  const [downloading, setDownloading] = useState<Set<string>>(new Set())

  // B-12: the query hands React Query's abort signal to `apiFetch`.
  const list = useQuery({
    queryKey: ['indexers'],
    queryFn: ({ signal }) => fetchIndexers(signal),
  })
  // `?? []` because settings-page fixtures mock this endpoint with `{}`.
  const indexers: IndexerRow[] = list.data?.indexers ?? []

  function reload() {
    queryClient.invalidateQueries({ queryKey: ['indexers'] })
  }

  function startEdit(row: IndexerRow) {
    setEditingId(row.id)
    setForm({ name: row.name, url: row.url, api_key: '', categories: row.categories })
    setNotice(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setNotice(null)
  }

  async function submitForm() {
    const body: IndexerInput = {
      name: form.name,
      url: form.url,
      api_key: form.api_key,
      categories: form.categories,
    }
    const result =
      editingId === null ? await createIndexer(body) : await updateIndexer(editingId, body)
    if (result.ok) {
      setNotice({ text: editingId === null ? 'Indexador añadido.' : 'Cambios guardados.', tone: 'ok' })
      setEditingId(null)
      setForm(EMPTY_FORM)
      reload()
    } else {
      setNotice({ text: result.detail ?? 'No se pudo guardar.', tone: 'error' })
    }
  }

  async function toggleEnabled(row: IndexerRow) {
    const result = await updateIndexer(row.id, { enabled: row.enabled ? false : true })
    if (result.ok) {
      setNotice({ text: 'Indexador actualizado.', tone: 'ok' })
      reload()
    } else {
      setNotice({ text: result.detail ?? 'No se pudo actualizar.', tone: 'error' })
    }
  }

  async function probe(row: IndexerRow) {
    const result = await testIndexer(row.id)
    setTestResults((prev) => ({ ...prev, [row.id]: result }))
  }

  async function remove(row: IndexerRow) {
    // The repo's confirm pattern (`FileManager`): a deletion silently shrinks
    // every future search, so it must be asked about, not clicked through.
    if (!confirm(`¿Eliminar el indexador «${row.name}»?`)) return
    const result = await deleteIndexer(row.id)
    if (result.ok) {
      setNotice({ text: 'Indexador eliminado.', tone: 'ok' })
      if (editingId === row.id) cancelEdit()
      reload()
    } else {
      setNotice({ text: result.detail ?? 'No se pudo eliminar.', tone: 'error' })
    }
  }

  function toggleSearchSource(source: IndexerSearchSource) {
    setSelectedSources((prev) => {
      const next = new Set(prev)
      if (next.has(source)) next.delete(source)
      else next.add(source)
      return next
    })
  }

  function runSearch() {
    const text = query.trim()
    const sources = INDEXER_SOURCES.filter((source) => selectedSources.has(source))
    if (!text) {
      setNotice({ text: 'Escribe qué buscar.', tone: 'error' })
      return
    }
    if (sources.length === 0) {
      setNotice({ text: 'Selecciona al menos una fuente.', tone: 'error' })
      return
    }
    setSearching(true)
    searchIndexers(text, sources).then((response) => {
      setSearch({ response, searched: sources, filter: 'all' })
      setSearching(false)
    })
  }

  function handleDownload(row: IndexerSearchRow, key: string) {
    if (downloading.has(key)) return
    setDownloading((prev) => new Set(prev).add(key))
    // `link ?? guid` — the row's built link is the better target when both
    // exist; the backend dispatches by the target's shape.
    const target = row.link ? { link: row.link } : { guid: row.guid }
    downloadIndexer(target)
      .then((result) => toast(result.detail, result.ok ? 'ok' : 'error'))
      .finally(() => {
        setDownloading((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      })
  }

  const noticeRole = notice?.tone === 'error' ? 'alert' : 'status'

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Indexadores</h3>
      <p className="shared-dirs-hint">
        Conexión directa con indexadores Torznab: se guardan en su propia tabla y actúan al
        instante (sin «Guardar configuración»). La búsqueda unificada de abajo consulta a la vez
        Torznab, aMule y Prowlarr.
      </p>

      {list.data?.error && <div className="error-box">{list.data.error}</div>}

      <div className="settings-group">
        <h4>Indexadores registrados</h4>
        {list.isPending ? (
          <div className="shared-dirs-empty">Cargando indexadores…</div>
        ) : indexers.length === 0 ? (
          <div className="shared-dirs-empty">
            No hay indexadores registrados. Añade el primero abajo.
          </div>
        ) : (
          <ul className="shared-dirs-list">
            {indexers.map((row) => {
              const probeResult = testResults[row.id]
              return (
                <li className="shared-dirs-row" key={row.id}>
                  <code>{row.name}</code>
                  <span className="shared-dirs-notice">{row.url}</span>
                  <code>{row.api_key || '(sin clave)'}</code>
                  {row.categories && (
                    <span className="shared-dirs-notice">Categorías: {row.categories}</span>
                  )}
                  <label className="settings-toggle-label">
                    <button
                      type="button"
                      className={`settings-toggle ${row.enabled ? 'on' : 'off'}`}
                      aria-label={`Habilitado de ${row.name}`}
                      onClick={() => void toggleEnabled(row)}
                    >
                      {row.enabled ? 'Sí' : 'No'}
                    </button>
                    Habilitado
                  </label>
                  <button
                    type="button"
                    className="action-btn"
                    aria-label={`Probar ${row.name}`}
                    onClick={() => void probe(row)}
                  >
                    Probar
                  </button>
                  <button
                    type="button"
                    className="action-btn"
                    aria-label={`Editar ${row.name}`}
                    onClick={() => startEdit(row)}
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    className="action-btn"
                    aria-label={`Eliminar ${row.name}`}
                    onClick={() => void remove(row)}
                  >
                    Eliminar
                  </button>
                  {probeResult &&
                    (probeResult.ok ? (
                      <div role="status">
                        ✅ Conectado — capabilities recibidas{capsCategories(probeResult.caps)}
                      </div>
                    ) : (
                      <div role="alert">❌ {probeResult.detail}</div>
                    ))}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="settings-group">
        <h4>{editingId === null ? 'Añadir indexador' : 'Editar indexador'}</h4>
        <div className="settings-field">
          <label className="settings-label" htmlFor="indexer-form-name">
            Nombre del indexador
          </label>
          <input
            id="indexer-form-name"
            className="settings-input"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div className="settings-field">
          <label className="settings-label" htmlFor="indexer-form-url">
            URL del indexador
          </label>
          <input
            id="indexer-form-url"
            className="settings-input"
            value={form.url}
            placeholder="http://localhost:9117/1/api"
            onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
          />
        </div>
        <div className="settings-field">
          <label className="settings-label" htmlFor="indexer-form-key">
            API Key del indexador
          </label>
          <input
            id="indexer-form-key"
            className="settings-input"
            type="password"
            value={form.api_key ?? ''}
            placeholder={editingId === null ? 'Clave del indexador' : '(sin cambio)'}
            onChange={(e) => setForm((f) => ({ ...f, api_key: e.target.value }))}
          />
        </div>
        <div className="settings-field">
          <label className="settings-label" htmlFor="indexer-form-categories">
            Categorías (separadas por coma)
          </label>
          <input
            id="indexer-form-categories"
            className="settings-input"
            value={form.categories ?? ''}
            placeholder="2000,100000"
            onChange={(e) => setForm((f) => ({ ...f, categories: e.target.value }))}
          />
        </div>
        <div className="settings-logs-controls">
          {editingId === null ? (
            <button type="button" className="action-btn" onClick={() => void submitForm()}>
              Añadir indexador
            </button>
          ) : (
            <>
              <button type="button" className="action-btn" onClick={() => void submitForm()}>
                Guardar cambios
              </button>
              <button type="button" className="action-btn" onClick={cancelEdit}>
                Cancelar
              </button>
            </>
          )}
          {notice && (
            <span className="shared-dirs-notice" role={noticeRole}>
              {notice.text}
            </span>
          )}
        </div>
      </div>

      <div className="settings-group">
        <h4>Búsqueda unificada</h4>
        <p className="shared-dirs-hint">
          Busca a la vez en las fuentes seleccionadas. «Descargar» envía la fila directamente al
          cliente: ed2k a aMule, magnet/http por el puente de descargas.
        </p>
        <div className="settings-field">
          <label className="settings-label" htmlFor="indexer-search-query">
            Texto a buscar
          </label>
          <input
            id="indexer-search-query"
            className="settings-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="shared-dirs-add">
          {INDEXER_SOURCES.map((source) => (
            <button
              key={source}
              type="button"
              className={`settings-toggle ${selectedSources.has(source) ? 'on' : 'off'}`}
              aria-pressed={selectedSources.has(source)}
              onClick={() => toggleSearchSource(source)}
            >
              {source}
            </button>
          ))}
          <button
            type="button"
            className="action-btn"
            onClick={searching ? undefined : () => runSearch()}
          >
            {searching ? 'Buscando…' : 'Buscar'}
          </button>
        </div>

        {search && (
          <div className="settings-group">
            <h4>Resultados</h4>

            {/* selectedIndexer's mechanic, mirrored: one selector over the
                sources that answered, counts included. */}
            <div className="shared-dirs-add">
              <button
                type="button"
                className={`settings-toggle ${search.filter === 'all' ? 'on' : 'off'}`}
                aria-pressed={search.filter === 'all'}
                onClick={() => setSearch((prev) => (prev ? { ...prev, filter: 'all' } : prev))}
              >
                Todas ({search.response.results.length})
              </button>
              {search.searched.map((source) => (
                <button
                  key={source}
                  type="button"
                  className={`settings-toggle ${search.filter === source ? 'on' : 'off'}`}
                  aria-pressed={search.filter === source}
                  onClick={() => setSearch((prev) => (prev ? { ...prev, filter: source } : prev))}
                >
                  {source} ({search.response.results.filter((r) => r.source === source).length})
                </button>
              ))}
            </div>

            {!search.response.ok && search.response.detail ? (
              // Every source failed: the one answer S4 refuses to dress up as
              // «sin resultados».
              <div className="error-box" role="alert">
                Error: {search.response.detail}
              </div>
            ) : (
              <>
                {/* Per-source honest states: rows, «Sin resultados», or every
                    skip named with its reason — never a silent empty. */}
                {(search.filter === 'all' ? search.searched : [search.filter]).map((source) => {
                  const skips = search.response.skipped.filter((s) => s.source === source)
                  const count = search.response.results.filter((r) => r.source === source).length
                  return (
                    <div key={source}>
                      {skips.map((skip, i) => (
                        <div key={i} className="shared-dirs-empty">
                          {skip.source}: {skip.reason}
                        </div>
                      ))}
                      {skips.length === 0 && count === 0 && (
                        <div className="shared-dirs-empty">{source}: Sin resultados</div>
                      )}
                    </div>
                  )
                })}
                {search.response.results.length === 0 && (
                  <div className="shared-dirs-empty">Sin resultados</div>
                )}

                {Array.from(
                  groupByIndexer(
                    search.filter === 'all'
                      ? search.response.results
                      : search.response.results.filter((r) => r.source === search.filter),
                  ).entries(),
                ).map(([key, rows]) => (
                  <div key={key} className="settings-group">
                    <h4>
                      🌐 {key} ({rows.length})
                    </h4>
                    <ul className="shared-dirs-list">
                      {rows.map((row) => {
                        const rowKey = String(search.response.results.indexOf(row))
                        const pending = downloading.has(rowKey)
                        const hasTarget = Boolean(row.link || row.guid)
                        return (
                          <li className="shared-dirs-row" key={rowKey}>
                            <code>{row.name}</code>
                            <span className="shared-dirs-notice">
                              {formatSize(row.size)}
                              {row.seeders != null ? ` · ⬆ ${row.seeders}` : ''}
                              {row.sources != null ? ` · ${row.sources} fuentes` : ''}
                            </span>
                            {hasTarget ? (
                              <button
                                type="button"
                                className="action-btn"
                                onClick={pending ? undefined : () => handleDownload(row, rowKey)}
                              >
                                {pending ? 'Descargando…' : 'Descargar'}
                              </button>
                            ) : (
                              <span className="shared-dirs-empty">Sin enlace</span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
