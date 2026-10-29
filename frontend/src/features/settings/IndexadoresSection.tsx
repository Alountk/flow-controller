/** «Indexadores» — the direct-connections registry + unified search (T6/S5-S6).
 *
 * A standalone section like `SharedDirsSection`: it reads and writes its own
 * SQLite table and acts on its own buttons, so it is NOT part of the settings
 * form ("Guardar configuración" must never claim to have saved this). The
 * `<Section>` wrapper in `Settings.tsx` is module-private and the named mold
 * (`SharedDirsSection`) renders its own `settings-section` heading — this
 * follows the mold instead of reaching through a circular import.
 *
 * config-1x1 T4 (S2): strict 1:1 with `odd/tasks/config-submenu/stitch-13-indexadores.html`
 * — panel header («Importar de Prowlarr/Jackett…» + «Añadir indexador»),
 * stacked cards (Búsqueda unificada → Fuentes integradas (T7/S5) →
 * Indexadores Torznab registrados → Nuevo indexador → callout), the registry table and the categories grid in
 * `Settings.css` (zero inline styles). Rule: diseño → implementación;
 * imposible → REPORTAR; jamás variante propia. Reported, not invented:
 *  - «Importar de Prowlarr/Jackett…» (Step 5 does not exist yet): visible,
 *    honestly disabled with a truthful title — no fake action, not hidden;
 *  - the in-form «Probar» (probe unsaved values): the backend only probes by
 *    id (`POST /api/indexers/{id}/test`), so it is visible but honestly
 *    disabled too (the per-row «Probar» is the real probe);
 *  - mockup data with no backend source is NOT rendered: «17 fuentes activas»,
 *    «Latencia media: 120ms», «Jackett local», «Red eD2k activa», the rows'
 *    «Añadido: …» / «Torznab ID: …» texts, and the bottom build/uptime bar;
 *  - the rows' «L: …» (leechers) does not exist in `IndexerSearchRow` — only
 *    «S: …» renders;
 *  - probe outcomes have no design slot: they report below the table.
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

import { useRef, useState } from 'react'
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
import { fetchServices } from '../../shared/api/services.ts'
import './Settings.css'

/**
 * stitch-13 agrupa los resultados por FUENTE («Resultados de Prowlarr»,
 * «Resultados Torznab directos», «Resultados daemon aMule (eD2k/Kad)») y el
 * indexador de cada fila viaja en su badge. El orden de los grupos es el de
 * llegada de las filas (el del mockup refleja sus datos, no una regla).
 */
function groupBySource(rows: IndexerSearchRow[]): Map<string, IndexerSearchRow[]> {
  const map = new Map<string, IndexerSearchRow[]>()
  for (const row of rows) {
    const key = row.source
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(row)
  }
  return map
}

/** Los títulos de grupo, literales del diseño; fuente desconocida → honesto. */
const GROUP_TITLE: Record<string, string> = {
  torznab: 'Resultados Torznab directos',
  prowlarr: 'Resultados de Prowlarr',
  amule: 'Resultados daemon aMule (eD2k/Kad)',
}

/** Emoji del chip de fuente, literal del diseño (decorativo para el nombre
 *  accesible: el chip se llama «torznab», no «🌐 torznab»). */
const CHIP_EMOJI: Record<IndexerSearchSource, string> = {
  torznab: '🌐',
  amule: '📥',
  prowlarr: '🔍',
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

/** S3 («config-submenu» T4/L2): the «Categorías» checkbox grid. Every box
 * shows name AND id («Películas 2000» = name «Películas», id 2000).
 * «Todas (sin filtro)» is not in this list: it is the empty csv. */
const CATEGORY_ITEMS = [
  { id: '2000', name: 'Películas' },
  { id: '2010', name: 'Películas HD' },
  { id: '2020', name: '3D' },
  { id: '2045', name: 'Remux' },
  { id: '5000', name: 'Series' },
  { id: '5010', name: 'Series HD' },
  { id: '5070', name: 'Anime' },
  { id: '5040', name: 'Documentales' },
  { id: '3000', name: 'Música' },
  { id: '3030', name: 'Audiolibros' },
  { id: '4000', name: 'Libros' },
  { id: '1000', name: 'Consola' },
]

const CATEGORY_IDS = new Set(CATEGORY_ITEMS.map((c) => c.id))

/** Checked ids from the csv, in stored order. `[]` ⇔ «Todas» checked. */
function parseCategories(csv: string | undefined): string[] {
  return (csv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Rebuild the csv: standard ids in CATEGORY_ITEMS order, then unknown ids
 * (custom 100xxx, …) in their stored order — stable regardless of click
 * order, and a custom id NEVER disappears: dropping a user's stored id would
 * be data loss (S3 round-trip rule). */
function buildCategoriesCsv(ids: string[]): string {
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const item of CATEGORY_ITEMS) {
    if (ids.includes(item.id) && !seen.has(item.id)) {
      ordered.push(item.id)
      seen.add(item.id)
    }
  }
  for (const id of ids) {
    if (!CATEGORY_IDS.has(id) && !seen.has(id)) {
      ordered.push(id)
      seen.add(id)
    }
  }
  return ordered.join(',')
}

/** T7/S5 — «Fuentes integradas»: fuentes de primer nivel que la búsqueda
 *  unificada consulta directamente (el fan-out ya las llama en paralelo).
 *  NO son endpoints Torznab ni filas del registro (éste sigue siendo sólo
 *  Torznab): aMule se configura en la pestaña aMule (fila accionable →
 *  onOpenGeneral) y
 *  Prowlarr llegará con la importación del paso 5 (fila estática — aquí NO se
 *  inventa una acción; su affordance disabled-honesto es el de la cabecera). */
const INTEGRATED_SOURCES = [
  { key: 'amule', name: 'aMule (EC)', action: 'Configurar en la pestaña aMule (EC directo)' },
  { key: 'prowlarr', name: 'Prowlarr', action: null },
] as const

export function IndexadoresSection({
  onOpenGeneral,
}: {
  /** El enlace «la pestaña aMule (EC directo)» del callout conmuta al panel
   *  aMule (espejo exacto de `onOpenIndexadores` en AmuleEcSection). */
  onOpenGeneral: () => void
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<IndexerInput & typeof EMPTY_FORM>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [showKey, setShowKey] = useState(false)
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
  } | null>(null)
  const [downloading, setDownloading] = useState<Set<string>>(new Set())
  const nameInputRef = useRef<HTMLInputElement>(null)

  // B-12: the query hands React Query's abort signal to `apiFetch`.
  const list = useQuery({
    queryKey: ['indexers'],
    queryFn: ({ signal }) => fetchIndexers(signal),
  })
  // T7/S5 — presencia de configuración («sin salir a la red»), jamás sondeo:
  // para eso está /api/services/test. Misma query key que
  // `useConfiguredServices` (mismo endpoint y payload, un solo cache entry).
  const services = useQuery({ queryKey: ['services'], queryFn: () => fetchServices() })
  // `?? []` because settings-page fixtures mock this endpoint with `{}`.
  const indexers: IndexerRow[] = list.data?.indexers ?? []

  function reload() {
    queryClient.invalidateQueries({ queryKey: ['indexers'] })
  }

  /** Los botones «Añadir indexador» (cabecera y pie de la tabla) anclan al
   *  formulario siempre visible del diseño. Sin reseteo: pisar un borrador en
   *  curso sería pérdida de datos. */
  function focusForm() {
    nameInputRef.current?.focus()
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

  function selectAllSources() {
    setSelectedSources(new Set(INDEXER_SOURCES))
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
      setSearch({ response, searched: sources })
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

  // «Categorías» checkbox state derives from the csv — the submit shape is
  // untouched. Empty ⇔ «Todas (sin filtro)»; unknown ids render as extra
  // «(personalizada)» boxes so the round-trip loses nothing.
  const selectedIds = parseCategories(form.categories)
  const selected = new Set(selectedIds)
  const customIds = selectedIds.filter((id) => !CATEGORY_IDS.has(id))
  const todasChecked = selectedIds.length === 0

  function toggleCategory(id: string) {
    setForm((f) => {
      const ids = parseCategories(f.categories)
      const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
      // Unchecking the last specific one lands on '' ⇔ «Todas» checked again:
      // there is no state where nothing is checked.
      return { ...f, categories: buildCategoriesCsv(next) }
    })
  }

  function checkTodas() {
    // Exclusive: checking «Todas» wipes every specific one. Clicking the
    // already-checked box keeps it checked (same empty csv — never empty).
    setForm((f) => ({ ...f, categories: '' }))
  }

  // Los chips son la «fuente» del diseño: alcance de la búsqueda (aria-pressed)
  // y filtro de visibilidad de los grupos tras buscar. Los conteos son los
  // RESULTADOS reales por fuente (jamás datos inventados).
  const allSelected = INDEXER_SOURCES.every((source) => selectedSources.has(source))
  const visibleSources = new Set<string>(selectedSources)
  const visibleGroups = search
    ? groupBySource(search.response.results.filter((row) => visibleSources.has(row.source)))
    : new Map<string, IndexerSearchRow[]>()
  const searchFailed = Boolean(search && !search.response.ok && search.response.detail)

  return (
    <div className="settings-section">
      {/* Cabecera del panel (stitch-13): título + subtítulo y las acciones
          «Importar de Prowlarr/Jackett…» / «Añadir indexador» arriba a la
          derecha. La importación (Step 5) aún no existe: visible, deshabilitada
          y con un título honesto — jamás una acción falsa ni un hueco. */}
      <div className="settings-panel-header">
        <div>
          <h2 className="settings-panel-title">Indexadores</h2>
          <p className="settings-panel-subtitle">Fuentes Torznab directas para buscar y descargar</p>
        </div>
        <div className="settings-panel-actions">
          <button
            type="button"
            className="settings-btn settings-btn-secondary"
            disabled
            title="Disponible al importar de Prowlarr (próximo paso)"
          >
            Importar de Prowlarr/Jackett…
          </button>
          <button type="button" className="settings-btn settings-btn-primary" onClick={focusForm}>
            Añadir indexador
          </button>
        </div>
      </div>

      {list.data?.error && <div className="error-box">{list.data.error}</div>}

      <div className="indexadores-cards">
        {/* CARD 1: BÚSQUEDA UNIFICADA (stitch-13) */}
        <section className="indexadores-card">
          <div className="indexadores-card-head">
            <div>
              <h3 className="indexadores-card-title">Búsqueda unificada</h3>
              <p className="indexadores-card-subtitle">
                Sondeo en tiempo real a través de fuentes Torznab locales y remotas configuradas.
              </p>
            </div>
            {/* «17 fuentes activas» del mockup: dato inventado — REPORTADO,
                no renderizado. */}
          </div>

          <div className="indexadores-search-bar">
            <input
              className="indexadores-search-input"
              type="text"
              aria-label="Buscar en todas las fuentes…"
              placeholder="Buscar en todas las fuentes…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="button"
              className="settings-btn settings-btn-primary"
              onClick={searching ? undefined : () => runSearch()}
            >
              {searching ? 'Buscando…' : 'Buscar'}
            </button>
          </div>

          {/* Chips de fuente con conteos (literal del diseño) */}
          <div className="indexadores-source-chips">
            <span className="indexadores-chips-label">Fuentes:</span>
            <button
              type="button"
              className={`indexadores-chip ${allSelected ? 'active' : ''}`}
              aria-pressed={allSelected}
              onClick={selectAllSources}
            >
              Todas{' '}
              {search && (
                <span className="indexadores-chip-count">{search.response.results.length}</span>
              )}
            </button>
            {INDEXER_SOURCES.map((source) => (
              <button
                key={source}
                type="button"
                className={`indexadores-chip ${selectedSources.has(source) ? 'active' : ''}`}
                aria-pressed={selectedSources.has(source)}
                onClick={() => toggleSearchSource(source)}
              >
                <span aria-hidden="true">{CHIP_EMOJI[source]}</span> {source}{' '}
                {search && (
                  <span className="indexadores-chip-count">
                    {search.response.results.filter((r) => r.source === source).length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Resultados agrupados por fuente con cabeceras de grupo. */}
          {search && !searchFailed && (
            <div className="indexadores-groups">
              {Array.from(visibleGroups.entries()).map(([source, rows]) => (
                <div
                  key={source}
                  className={`indexadores-group ${source === 'amule' ? 'indexadores-group--amule' : ''}`}
                >
                  <div className="indexadores-group-head">
                    <div className="indexadores-group-head-left">
                      <span className="indexadores-group-title">
                        {GROUP_TITLE[source] ?? `Resultados de ${source}`}
                      </span>
                      <span className="indexadores-group-count">{rows.length}</span>
                    </div>
                    {/* «Latencia media: 120ms» / «Jackett local» / «Red eD2k
                        activa» del mockup: datos inventados — REPORTADOS. */}
                  </div>
                  <div className="indexadores-group-rows">
                    {rows.map((row) => {
                      const rowKey = String(search.response.results.indexOf(row))
                      const pending = downloading.has(rowKey)
                      const hasTarget = Boolean(row.link || row.guid)
                      return (
                        <div className="indexadores-result-row" key={rowKey}>
                          <div className="indexadores-result-main">
                            <p className="indexadores-result-name">{row.name}</p>
                            <div className="indexadores-result-meta">
                              <span className="indexadores-result-badge">
                                {row.indexer || row.source}
                              </span>
                              {/* «Añadido: …» / «Torznab ID: …» del mockup:
                                  datos inventados — REPORTADOS. */}
                            </div>
                          </div>
                          <div className="indexadores-result-side">
                            <span className="indexadores-result-size">{formatSize(row.size)}</span>
                            {row.seeders != null && (
                              <span className="indexadores-result-metric">
                                {/* «L: …» (leechers) no existe en la API — REPORTADO */}
                                <span className="seeders">S: {row.seeders}</span>
                              </span>
                            )}
                            {row.sources != null && (
                              <span className="indexadores-result-sources">
                                fuentes: {row.sources}
                              </span>
                            )}
                            {hasTarget ? (
                              <button
                                type="button"
                                className="indexadores-result-download"
                                onClick={pending ? undefined : () => handleDownload(row, rowKey)}
                              >
                                {pending ? 'Descargando…' : 'Descargar'}
                              </button>
                            ) : (
                              <span className="indexadores-empty">Sin enlace</span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Estados honestos al pie: fuente omitida con su motivo,
              «Sin resultados» y «Error: …» — nunca un vacío mudo. */}
          {search && (
            <div className="indexadores-search-statuses">
              {searchFailed ? (
                <div className="indexadores-status-error" role="alert">
                  Error: {search.response.detail}
                </div>
              ) : (
                <>
                  {search.searched.map((source) => {
                    const skips = search.response.skipped.filter((s) => s.source === source)
                    const count = search.response.results.filter(
                      (r) => r.source === source,
                    ).length
                    return (
                      <div key={source}>
                        {skips.map((skip, i) => (
                          <div key={i} className="indexadores-status-skip">
                            <strong>{skip.source}:</strong> {skip.reason} —{' '}
                            <span className="indexadores-status-muted">(fuente omitida)</span>
                          </div>
                        ))}
                        {skips.length === 0 && count === 0 && (
                          <div className="indexadores-status-empty">{source}: Sin resultados</div>
                        )}
                      </div>
                    )
                  })}
                  {search.response.results.length === 0 && (
                    <div className="indexadores-status-empty">Sin resultados</div>
                  )}
                </>
              )}
            </div>
          )}
        </section>

        {/* CARD 2: FUENTES INTEGRADAS (config-1x1 T7/S5) — aMule (EC) y
            Prowlarr como fuentes de primer nivel, ANTES del registro. Datos
            de GET /api/services (presencia de configuración, sin sondeo de
            red); estados honestos «Configurado»/«No configurado» y la URL (o
            el placeholder «sin configurar» cuando no hay ninguna). */}
        <section className="indexadores-card">
          <div className="indexadores-card-head">
            <div>
              <h3 className="indexadores-card-title">Fuentes integradas</h3>
              <p className="indexadores-card-subtitle">
                Fuentes de primer nivel que la búsqueda unificada consulta directamente. No son
                endpoints Torznab y no se añaden al registro, que sigue siendo sólo Torznab.
              </p>
            </div>
          </div>

          {services.isPending ? (
            <div className="indexadores-empty">Cargando fuentes…</div>
          ) : services.isError ? (
            <div className="indexadores-empty" role="alert">
              No se pudo consultar la configuración de las fuentes.
            </div>
          ) : (
            <div className="indexadores-sources">
              {INTEGRATED_SOURCES.map((source) => {
                const listed = services.data?.services?.find((s) => s.key === source.key)
                // Sin fila en el payload (degenerado) → nada configurado: se
                // reporta lo conocido, jamás se inventa un «Configurado».
                const configured = listed
                  ? listed.configured
                  : (services.data?.configured ?? []).includes(source.key)
                const url = listed?.url?.trim() ? listed.url : ''
                const body = (
                  <>
                    <span className="indexadores-source-name">{source.name}</span>
                    {url ? (
                      <code className="indexadores-source-url">{url}</code>
                    ) : (
                      <span className="indexadores-source-url indexadores-source-url--empty">
                        sin configurar
                      </span>
                    )}
                    <span className={`indexadores-source-status ${configured ? 'on' : 'off'}`}>
                      {configured ? 'Configurado' : 'No configurado'}
                    </span>
                    {source.action && (
                      <span className="indexadores-source-action">{source.action}</span>
                    )}
                  </>
                )
                // La fila aMule es accionable (click Y teclado: botón nativo)
                // → onOpenGeneral, la misma prop del callout: salta a la
                // pestaña aMule, donde vive la tarjeta aMule (EC).
                return source.action ? (
                  <button
                    key={source.key}
                    type="button"
                    className="indexadores-source-row indexadores-source-row--actionable"
                    aria-label={`${source.name} — ${source.action}`}
                    onClick={onOpenGeneral}
                  >
                    {body}
                  </button>
                ) : (
                  <div key={source.key} className="indexadores-source-row">
                    {body}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* CARD 3: INDEXADORES TORZNAB REGISTRADOS (stitch-13) */}
        <section className="indexadores-card">
          <div className="indexadores-card-head">
            <div>
              <h3 className="indexadores-card-title">Indexadores Torznab registrados</h3>
              <p className="indexadores-card-subtitle">
                Servidores y agregadores Torznab estándar para consultas automáticas.
              </p>
            </div>
            {/* El badge del diseño con el dato REAL del listado. */}
            <span className="indexadores-card-badge">{indexers.length} registrados</span>
          </div>

          {list.isPending ? (
            <div className="indexadores-empty">Cargando indexadores…</div>
          ) : indexers.length === 0 ? (
            <div className="indexadores-empty">
              No hay indexadores registrados. Añade el primero abajo.
            </div>
          ) : (
            <div className="indexadores-table-wrap">
              <table className="indexadores-table">
                <thead>
                  <tr>
                    <th className="indexadores-table-state">Estado</th>
                    <th>Nombre</th>
                    <th>URL</th>
                    <th>Categorías</th>
                    <th>API Key</th>
                    <th className="indexadores-table-actions">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {indexers.map((row) => (
                    <tr key={row.id} className={row.enabled ? undefined : 'disabled'}>
                      <td className="indexadores-table-state">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={Boolean(row.enabled)}
                          className={`indexadores-switch ${row.enabled ? 'on' : 'off'}`}
                          aria-label={`Habilitado de ${row.name}`}
                          onClick={() => void toggleEnabled(row)}
                        >
                          <span className="indexadores-switch-knob" aria-hidden="true" />
                        </button>
                      </td>
                      <td>
                        <div className="indexadores-cell-name">
                          <span
                            className={`indexadores-row-dot ${row.enabled ? 'on' : 'off'}`}
                            aria-hidden="true"
                          />
                          <span className="indexadores-row-name">{row.name}</span>
                        </div>
                      </td>
                      <td>
                        <code className="indexadores-cell-code">{row.url}</code>
                      </td>
                      <td>
                        <code className="indexadores-cell-code">
                          {row.categories || '— (todas)'}
                        </code>
                      </td>
                      <td>
                        {/* La máscara llega del backend — el único shape que
                            viaja; jamás se escribe de vuelta sin tocar. */}
                        <code className="indexadores-cell-code">{row.api_key || '(sin clave)'}</code>
                      </td>
                      <td className="indexadores-table-actions">
                        <div className="indexadores-row-actions">
                          <button
                            type="button"
                            className="indexadores-row-action"
                            aria-label={`Probar ${row.name}`}
                            onClick={() => void probe(row)}
                          >
                            Probar
                          </button>
                          <button
                            type="button"
                            className="indexadores-row-action"
                            aria-label={`Editar ${row.name}`}
                            onClick={() => startEdit(row)}
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            className="indexadores-row-action danger"
                            aria-label={`Eliminar ${row.name}`}
                            onClick={() => void remove(row)}
                          >
                            Eliminar
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Los resultados de «Probar» no tienen hueco en el diseño: se
              REPORTAN debajo de la tabla, con nombre y verdad (caps/detalle). */}
          {Object.keys(testResults).length > 0 && (
            <div className="indexadores-probe-results">
              {Object.entries(testResults).map(([id, result]) => {
                const name = indexers.find((r) => r.id === Number(id))?.name ?? `#${id}`
                return (
                  <div
                    key={id}
                    className="indexadores-probe-result"
                    role={result.ok ? 'status' : 'alert'}
                  >
                    <strong>{name}:</strong>{' '}
                    {result.ok
                      ? `✅ Conectado — capabilities recibidas${capsCategories(result.caps)}`
                      : `❌ ${result.detail}`}
                  </div>
                )
              })}
            </div>
          )}

          <div className="indexadores-add-row">
            <button type="button" className="indexadores-add-link" onClick={focusForm}>
              + Añadir indexador
            </button>
          </div>
        </section>

        {/* CARD 4: NUEVO INDEXADOR (formulario del diseño; la rejilla de
            categorías conserva la lógica T4-anterior BYTE a BYTE y sólo cambia
            de presentación — CSS, sin inline styles) */}
        <section className="indexadores-card indexadores-form-card">
          <div className="indexadores-card-head">
            <div>
              <h3 className="indexadores-card-title">
                {editingId === null ? 'Nuevo indexador' : 'Editar indexador'}
              </h3>
              <p className="indexadores-card-subtitle">
                Configuración de un endpoint Torznab personalizado.
              </p>
            </div>
          </div>

          <div className="indexadores-form-grid">
            <label className="settings-field">
              <span className="settings-label">Nombre</span>
              <input
                className="settings-input"
                ref={nameInputRef}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="settings-field">
              <span className="settings-label">URL</span>
              <input
                className="settings-input"
                value={form.url}
                placeholder="http://localhost:9117/1/api"
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              />
            </label>
            {/* The «Mostrar» toggle stays outside the label: a label may hold
                only one labelable control — the input. */}
            <div className="settings-field indexadores-key-field">
              <label className="settings-field">
                <span className="settings-label">API Key</span>
                <input
                  className="settings-input"
                  type={showKey ? 'text' : 'password'}
                  value={form.api_key ?? ''}
                  placeholder={editingId === null ? 'Clave del indexador' : '(sin cambio)'}
                  onChange={(e) => setForm((f) => ({ ...f, api_key: e.target.value }))}
                />
              </label>
              {/* Design's «Mostrar u ocultar»: reveals the key the user typed,
                  never the saved mask (the field arrives empty when editing). */}
              <button
                type="button"
                className="indexadores-key-toggle"
                title="Mostrar u ocultar"
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? 'Ocultar' : 'Mostrar'}
              </button>
            </div>
            <div className="settings-field indexadores-form-wide">
              <span className="settings-label" id="indexer-form-categories">
                Categorías
              </span>
              <div
                role="group"
                aria-labelledby="indexer-form-categories"
                className="indexadores-category-grid"
              >
                <label className="indexadores-category-item">
                  <input type="checkbox" checked={todasChecked} onChange={checkTodas} />
                  Todas (sin filtro)
                </label>
                {CATEGORY_ITEMS.map((item) => (
                  <label key={item.id} className="indexadores-category-item">
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={() => toggleCategory(item.id)}
                    />
                    {item.name} {item.id}
                  </label>
                ))}
                {customIds.map((id) => (
                  <label key={id} className="indexadores-category-item">
                    <input type="checkbox" checked onChange={() => toggleCategory(id)} />
                    {id} (personalizada)
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="indexadores-form-foot">
            <p className="indexadores-form-note">
              Prueba la conexión con <code>t=caps</code> antes de guardar. La clave se guarda
              cifrada y nunca se muestra completa.
            </p>
            <div className="indexadores-form-actions">
              {/* La nota pide «probar antes de guardar»; la sonda con valores
                  sin guardar no existe aún (el backend sólo prueba por id):
                  visible, honesta y REPORTADA. */}
              <button
                type="button"
                className="settings-btn settings-btn-secondary"
                disabled
                title="Disponible al probar los valores escritos (próximo paso)"
              >
                Probar
              </button>
              <button
                type="button"
                className="settings-btn settings-btn-primary"
                onClick={() => void submitForm()}
              >
                Guardar
              </button>
              {editingId !== null && (
                <button
                  type="button"
                  className="settings-btn settings-btn-secondary"
                  onClick={cancelEdit}
                >
                  Cancelar
                </button>
              )}
              {notice && (
                <span className="indexadores-form-notice" role={noticeRole}>
                  {notice.text}
                </span>
              )}
            </div>
          </div>
        </section>

        {/* CARD 5: CALLOUT INFORMATIVO FINAL (literal del diseño) */}
        <div className="indexadores-callout">
          <p className="indexadores-callout-text">
            La conexión a aMule no es un indexador: su host, puerto y contraseña EC se configuran
            en{' '}
            <a
              className="indexadores-callout-link"
              href="#"
              onClick={(e) => {
                e.preventDefault()
                // El estado del tab vive en `Settings.tsx`: el enlace conmuta
                // a la pestaña aMule por la prop real `onOpenGeneral` (espejo
                // de `onOpenIndexadores` en AmuleEcSection). Accionable, no
                // decorativo.
                onOpenGeneral()
              }}
            >
              la pestaña aMule (EC directo)
            </a>
            . Los resultados de la fuente «amule» salen de esa conexión.
          </p>
        </div>
      </div>
    </div>
  )
}
