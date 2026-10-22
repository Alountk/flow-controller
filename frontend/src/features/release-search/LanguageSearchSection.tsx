import { useRef, useState } from 'react'
import {
  alternativeLanguageDownload,
  alternativeLanguageSearch,
  type AlternativeTitle,
  type LanguageSearchRelease,
} from '../../shared/api/mixer.ts'
import { formatBytes } from '../../shared/utils/text.ts'

/** T3/S4/S5: everything the «Búsqueda en idioma» section needs from the
 *  alternative lookup. Its PRESENCE on `ReleaseSearchModal` is the
 *  `enableLanguageSearch` gate: only «Buscar y descargar alternativa» passes
 *  it (S5 «Sólo en alternativa»), every other mount renders nothing. */
export interface LanguageSearchContext {
  /** Radarr's `originalTitle` — null when the lookup payload has none. */
  originalTitle: string | null
  /** Radarr's `alternateTitles`, Radarr order, capped at 12 server-side. */
  alternateTitles: AlternativeTitle[]
  /** The Radarr movie id — sent as `movieId` on every search. */
  movieId: number
}

interface Chip {
  key: string
  /** «ORIGINAL: <title>» / «RU: Grom» / bare title when no language. */
  label: string
  title: string
  language: string | null
}

/**
 * S4 «Chips de idioma + input»: the titles the lookup payload carries as
 * one-click chips, plus a FREE-TEXT input for the ones TMDB does not have
 * («Артур и минипуты» typed by hand). «Buscar en Prowlarr» searches with the
 * term AS WRITTEN (S6: a Russian title for a Russian release). Each row
 * (title, indexer, seeders, size) offers T4/S7's «Descargar» — the row's
 * magnet or .torrent link goes straight to the download client, with the
 * pending/success/failure state kept per row.
 */
export function LanguageSearchSection({ context }: { context: LanguageSearchContext }) {
  const [query, setQuery] = useState('')
  // The language of the chip that filled the input, if any: it rides the
  // search request. Hand-typed text has no language — editing the input
  // drops it, so a stale code never claims a new term.
  const [chipLanguage, setChipLanguage] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // null = no search yet (renders nothing), [] = searched, nothing found.
  const [results, setResults] = useState<LanguageSearchRelease[] | null>(null)
  // T4/S7: one download state per row (by guid) — idle, adding, or added.
  const [downloads, setDownloads] = useState<
    Record<string, { phase: 'idle' | 'pending' | 'done'; error: string | null }>
  >({})
  // The synchronous half of the double-click guard: state cannot guard two
  // clicks dispatched in the same tick, a ref can.
  const adding = useRef<Set<string>>(new Set())

  const chips: Chip[] = []
  if (context.originalTitle) {
    chips.push({
      key: 'original',
      label: `ORIGINAL: ${context.originalTitle}`,
      title: context.originalTitle,
      language: null,
    })
  }
  for (const alt of context.alternateTitles) {
    chips.push({
      key: `alt:${alt.title}`,
      label: alt.language ? `${alt.language.toUpperCase()}: ${alt.title}` : alt.title,
      title: alt.title,
      language: alt.language,
    })
  }

  function fill(title: string, language: string | null) {
    setQuery(title)
    setChipLanguage(language)
    setError(null)
  }

  async function runSearch() {
    // The guard the disabled button cannot give: `fireEvent.click` (and some
    // browsers' synthesized clicks) fire on disabled buttons.
    const term = query.trim()
    if (!term || searching) return
    setSearching(true)
    setError(null)
    setResults(null)
    try {
      const resp = await alternativeLanguageSearch(term, {
        language: chipLanguage ?? undefined,
        movieId: context.movieId,
      })
      setResults(resp.releases)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'error desconocido')
    } finally {
      setSearching(false)
    }
  }

  async function download(row: LanguageSearchRelease) {
    // T2 guarantees exactly one of the two is set; neither means there is
    // nothing to add — the button is disabled, but the guard lives here too.
    const url = row.magnet_url ?? row.download_url
    const key = row.guid
    // The guards the disabled button cannot give: `fireEvent.click` (and some
    // browsers' synthesized clicks) fire on disabled buttons — one add per
    // row at a time, and never a second for a row already added.
    if (!url || adding.current.has(key) || downloads[key]?.phase === 'done') return
    adding.current.add(key)
    setDownloads((prev) => ({ ...prev, [key]: { phase: 'pending', error: null } }))
    try {
      await alternativeLanguageDownload(url, row.title)
      setDownloads((prev) => ({ ...prev, [key]: { phase: 'done', error: null } }))
    } catch (err) {
      setDownloads((prev) => ({
        ...prev,
        [key]: {
          phase: 'idle',
          error: err instanceof Error ? err.message : 'error desconocido',
        },
      }))
    } finally {
      adding.current.delete(key)
    }
  }

  return (
    <section className="lang-search">
      <h3 className="lang-search-title">Búsqueda en idioma</h3>
      {chips.length > 0 && (
        <div className="lang-search-chips">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="lang-search-chip"
              onClick={() => fill(chip.title, chip.language)}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
      <div className="lang-search-form">
        <input
          type="text"
          className="lang-search-input"
          placeholder="Título en el idioma que quieras"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setChipLanguage(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch()
          }}
        />
        <button
          type="button"
          className="lang-search-btn"
          onClick={() => void runSearch()}
          disabled={searching || !query.trim()}
        >
          Buscar en Prowlarr
        </button>
      </div>
      {searching && <div className="lang-search-status">Buscando en Prowlarr…</div>}
      {error && (
        <div className="lang-search-error" role="alert">
          {error}
        </div>
      )}
      {results !== null && !searching && !error && (
        results.length === 0 ? (
          <div className="lang-search-empty">Sin resultados en Prowlarr</div>
        ) : (
          <div className="lang-search-rows">
            {results.map((row) => {
              const state = downloads[row.guid]
              const canAdd = Boolean(row.magnet_url ?? row.download_url)
              const label =
                state?.phase === 'done'
                  ? 'Descargado ✓'
                  : state?.phase === 'pending'
                    ? 'Descargando…'
                    : 'Descargar'
              return (
                <div key={row.guid} className="lang-search-row">
                  <div className="lang-search-row-title">{row.title}</div>
                  <div className="lang-search-row-meta">
                    <span className="lang-search-row-indexer">{row.indexer}</span>
                    <span className="lang-search-row-seeders">⬆ {row.seeders} semillas</span>
                    <span className="lang-search-row-size">{formatBytes(row.size)}</span>
                  </div>
                  <button
                    type="button"
                    className="lang-search-row-download"
                    onClick={() => void download(row)}
                    disabled={!canAdd || state?.phase === 'pending' || state?.phase === 'done'}
                  >
                    {label}
                  </button>
                  {state?.error && (
                    <div className="lang-search-row-error" role="alert">
                      {state.error}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      )}
    </section>
  )
}
