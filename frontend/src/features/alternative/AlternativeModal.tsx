import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  downloadIndexer,
  fetchIndexers,
  searchIndexers,
  type IndexerRow,
  type IndexerSearchResponse,
  type IndexerSearchRow,
  type IndexerSearchSource,
} from '../../shared/api/indexers.ts'
import type { AlternativeTitle } from '../../shared/api/mixer.ts'
import { LanguageSearchSection } from '../release-search/LanguageSearchSection.tsx'
import './AlternativeModal.css'

/**
 * «Buscar y descargar alternativa» sobre NUESTROS indexadores
 * («alternativa-indexadores» T3, specs S1-S4/S7/S8 + decisiones L6a-L6d).
 *
 * This modal REPLACES the Radarr release list for the alternative flow (S7):
 * checklist de indexadores → título precargado editable → resultados →
 * descargar, plus «Búsqueda en idioma» (Prowlarr) kept inside (S7's explicit
 * condition). No arr release jobs, no destination buttons, no filters/3D chips
 * — those belong to `ReleaseSearchModal`'s grab flow, not here.
 *
 * Contracts pinned here:
 * - S1: rows come from `GET /api/indexers`; `enabled` rows are checkable and
 *   CHECKED BY DEFAULT (L6a), `enabled: 0` rows stay visible but are never
 *   checkable nor searchable; one extra «aMule (EC)» checkbox, also checked by
 *   default (no config probe — an unconfigured aMule answers an honest
 *   `skipped`); Prowlarr NEVER appears (L6b).
 * - S2: the title input is prefilled from the prop and always editable.
 * - S3: NO auto-search on open (L6c) — an explicit «Buscar» button, disabled
 *   with a blank title or zero sources, with the same guard in the handler
 *   (jsdom `fireEvent.click` fires on disabled buttons). Selection maps to
 *   `sources` (`torznab` + the checked `indexer_ids`, `amule` for the EC
 *   checkbox) and never to `prowlarr`. Results render name, size, seeders
 *   when present and aMule's `sources` — NEVER labelled seeders; every
 *   `skipped` entry renders with its reason (honesty, contract T4/S4).
 * - S4: per-row «Descargar» → `downloadIndexer({ link ?? guid })` and the
 *   returned `detail` is rendered visibly (ok AND refusal are both 200
 *   `{ok, detail}`), with a per-row pending guard (double-click safe).
 * - S5: post-download is MANUAL (L2) — no `altWait` machinery here.
 * - S6: `movieId` 0 is legal (movie not in library): no library gate.
 * - S8: `audioLanguages` render as informational chips.
 */

export interface AlternativeModalProps {
  /** S2: prefilled, editable. */
  title: string
  /** LanguageSearchSection context. */
  originalTitle: string | null
  alternateTitles: AlternativeTitle[]
  /** 0 is legal (S6: the movie is not in the library). */
  movieId: number
  /** S8: informational chips. */
  audioLanguages: string[]
  onClose: () => void
}

/** Mirrors `IndexadoresSection.formatSize` — module-private on purpose. */
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

type DownloadState = {
  phase: 'idle' | 'pending' | 'done'
  ok: boolean | null
  detail: string | null
}

export function AlternativeModal({
  title,
  originalTitle,
  alternateTitles,
  movieId,
  audioLanguages,
  onClose,
}: AlternativeModalProps) {
  // S2: controlled state initialized from the prop — the user may rewrite it.
  const [query, setQuery] = useState(title)
  // S1's checklist model: enabled rows are checked UNTIL deselected (L6a's
  // default), so rows arriving async still land checked.
  const [deselected, setDeselected] = useState<Set<number>>(new Set())
  const [amule, setAmule] = useState(true)
  const [searching, setSearching] = useState(false)
  const [search, setSearch] = useState<{
    response: IndexerSearchResponse
  } | null>(null)
  // S4: one download state per row; the ref is the synchronous half of the
  // double-click guard (state cannot guard two clicks in the same tick).
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({})
  const busy = useRef<Set<string>>(new Set())

  // B-12: the query hands React Query's abort signal to `apiFetch`.
  const list = useQuery({
    queryKey: ['indexers'],
    queryFn: ({ signal }) => fetchIndexers(signal),
  })
  const rows: IndexerRow[] = list.data?.indexers ?? []

  // S1: `enabled: 0` rows are visible but NEVER checkable nor searchable.
  const torznabIds = rows
    .filter((row) => row.enabled !== 0 && !deselected.has(row.id))
    .map((row) => row.id)
  const selectedSources: IndexerSearchSource[] = []
  if (torznabIds.length > 0) selectedSources.push('torznab')
  if (amule) selectedSources.push('amule')

  const term = query.trim()
  const canSearch = Boolean(term) && selectedSources.length > 0

  function toggleRow(row: IndexerRow) {
    setDeselected((prev) => {
      const next = new Set(prev)
      if (next.has(row.id)) next.delete(row.id)
      else next.add(row.id)
      return next
    })
  }

  async function runSearch() {
    // L6c + the guard the disabled button cannot give: `fireEvent.click` (and
    // some browsers' synthesized clicks) fire on disabled buttons.
    if (!canSearch || searching) return
    setSearching(true)
    setDownloads({})
    try {
      const response = await searchIndexers(
        term,
        selectedSources,
        torznabIds.length > 0 ? torznabIds : undefined,
      )
      setSearch({ response })
    } finally {
      setSearching(false)
    }
  }

  async function download(row: IndexerSearchRow, key: string) {
    // S4: `link ?? guid` is the target; neither means there is nothing to add.
    const target = row.link ? { link: row.link } : row.guid ? { guid: row.guid } : null
    if (!target || busy.current.has(key) || downloads[key]?.phase === 'done') return
    busy.current.add(key)
    setDownloads((prev) => ({ ...prev, [key]: { phase: 'pending', ok: null, detail: null } }))
    try {
      const result = await downloadIndexer(target)
      setDownloads((prev) => ({
        ...prev,
        [key]: {
          phase: result.ok ? 'done' : 'idle',
          ok: result.ok,
          detail: result.detail,
        },
      }))
    } finally {
      busy.current.delete(key)
    }
  }

  // Chrome: Escape closes (the overlay owns its dialog — `ReleaseSearchModal`
  // closes the same way).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleBackdropClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="alt-modal-backdrop" onClick={handleBackdropClick}>
      <div
        className="alt-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Buscar y descargar alternativa"
      >
        <div className="alt-modal-header">
          <h2 className="alt-modal-heading">Buscar y descargar alternativa</h2>
          <button type="button" className="alt-modal-close" aria-label="Cerrar" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="alt-modal-body">
          {/* S8 — the lookup's audio languages, informational only. */}
          <section className="alt-modal-audio">
            <h3 className="alt-modal-section-title">Idiomas de audio</h3>
            <div className="alt-modal-audio-chips">
              {audioLanguages.map((lang) => (
                <span key={lang} className="alt-modal-audio-chip">
                  {lang}
                </span>
              ))}
            </div>
          </section>

          {/* S1 — checklist: registry rows + «aMule (EC)», Prowlarr never. */}
          <section className="alt-modal-sources">
            <h3 className="alt-modal-section-title">Dónde buscar</h3>
            <div className="alt-modal-source-list">
              {list.isPending && <div className="alt-modal-status">Cargando indexadores…</div>}
              {list.data?.error && (
                <div className="alt-modal-error" role="alert">
                  {list.data.error}
                </div>
              )}
              {rows.map((row) => (
                <label key={row.id} className="alt-modal-source-row">
                  <input
                    type="checkbox"
                    aria-label={`Buscar en ${row.name}`}
                    checked={row.enabled !== 0 && !deselected.has(row.id)}
                    disabled={row.enabled === 0}
                    onChange={() => toggleRow(row)}
                  />
                  <span className="alt-modal-source-name">{row.name}</span>
                  {row.enabled === 0 && (
                    <span className="alt-modal-source-off">deshabilitado</span>
                  )}
                </label>
              ))}
              <label className="alt-modal-source-row alt-modal-source-row--amule">
                <input
                  type="checkbox"
                  aria-label="Buscar en aMule (EC)"
                  checked={amule}
                  onChange={() => setAmule((prev) => !prev)}
                />
                <span className="alt-modal-source-name">aMule (EC)</span>
              </label>
            </div>
          </section>

          {/* S2 — prefilled, always editable. */}
          <section className="alt-modal-query">
            <label className="alt-modal-query-label" htmlFor="alt-modal-title-input">
              Título a buscar
            </label>
            <input
              id="alt-modal-title-input"
              className="alt-modal-query-input"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </section>

          {/* S3/L6c — the explicit search; opening the modal is not a search. */}
          <div className="alt-modal-actions">
            <button
              type="button"
              className="alt-modal-search-btn"
              onClick={() => void runSearch()}
              disabled={!canSearch || searching}
            >
              Buscar
            </button>
            {searching && <span className="alt-modal-status">Buscando…</span>}
          </div>

          {search && search.response.detail && (
            <div
              className={`alt-modal-search-notice ${
                search.response.ok
                  ? 'alt-modal-search-notice--ok'
                  : 'alt-modal-search-notice--error'
              }`}
            >
              {search.response.ok ? search.response.detail : `Error: ${search.response.detail}`}
            </div>
          )}

          {search && (
            <section className="alt-modal-results">
              <h3 className="alt-modal-section-title">Resultados</h3>
              {search.response.results.length === 0 && search.response.skipped.length === 0 && (
                <div className="alt-modal-empty">Sin resultados</div>
              )}
              <div className="alt-modal-result-list">
                {search.response.results.map((row, i) => {
                  const key = String(i)
                  const state = downloads[key]
                  const hasTarget = Boolean(row.link || row.guid)
                  return (
                    <div className="alt-modal-result-row" key={`${row.name}:${key}`}>
                      <div className="alt-modal-result-main">
                        <p className="alt-modal-result-name">{row.name}</p>
                        <div className="alt-modal-result-meta">
                          <span className="alt-modal-result-source">{row.indexer || row.source}</span>
                        </div>
                      </div>
                      <div className="alt-modal-result-side">
                        <span className="alt-modal-result-size">{formatSize(row.size)}</span>
                        {/* Seeders only when the source really reported them… */}
                        {row.seeders != null && (
                          <span className="alt-modal-result-seeders">S: {row.seeders}</span>
                        )}
                        {/* …and aMule's ED2K count as `sources`, NEVER seeders. */}
                        {row.sources != null && (
                          <span className="alt-modal-result-sources">fuentes: {row.sources}</span>
                        )}
                        {hasTarget ? (
                          <button
                            type="button"
                            className="alt-modal-result-download"
                            disabled={state?.phase === 'pending' || state?.phase === 'done'}
                            onClick={
                              state?.phase === 'pending' || state?.phase === 'done'
                                ? undefined
                                : () => void download(row, key)
                            }
                          >
                            {state?.phase === 'done'
                              ? 'Descargado ✓'
                              : state?.phase === 'pending'
                                ? 'Descargando…'
                                : 'Descargar'}
                          </button>
                        ) : (
                          <span className="alt-modal-result-nolink">Sin enlace</span>
                        )}
                      </div>
                      {/* S4: the server's own `detail` — acceptance AND refusal. */}
                      {state?.detail && (
                        <div
                          className={`alt-modal-result-detail ${
                            state.ok
                              ? 'alt-modal-result-detail--ok'
                              : 'alt-modal-result-detail--error'
                          }`}
                        >
                          {state.detail}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              {/* S3 honesty: every skipped source names itself and its reason. */}
              {search.response.skipped.length > 0 && (
                <div className="alt-modal-skipped">
                  <h4 className="alt-modal-skipped-title">Fuentes omitidas</h4>
                  <ul className="alt-modal-skipped-list">
                    {search.response.skipped.map((skip, i) => (
                      <li key={`${skip.source}:${i}`}>{`${skip.source}: ${skip.reason}`}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* S7 — «Búsqueda en idioma» (Prowlarr) kept inside the new modal. */}
          <LanguageSearchSection
            context={{ originalTitle, alternateTitles, movieId }}
          />
        </div>
      </div>
    </div>
  )
}
