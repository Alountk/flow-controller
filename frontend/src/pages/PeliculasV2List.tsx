import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../shared/api/auth.ts'
import { useDebouncedValue } from '../shared/hooks/useDebouncedValue.ts'
import { QualityBelowList } from '../features/quality/QualityBelowList.tsx'
import { ProbeLibraryCard } from '../shared/ui/ProbeLibraryCard.tsx'
import type { ReleaseSearchItem } from '../features/release-search/ReleaseSearchModal.tsx'
import type { ScanItem } from '../features/media-pane/components/ScanModal.tsx'
import { QuickActionsMenu } from './QuickActionsMenu.tsx'
import type { MediaDetail, MediaSelection } from '../features/media-pane/types.ts'
import { formatGrabMark } from '../shared/utils/grabMark.ts'
import type { AllMovie, PaginatedResponse } from '../shared/types.ts'
import './PeliculasV2.css'

/**
 * Películas V2 — the design's L2 list: poster rows, class chips with counts,
 * a name search that asks the server, a real pager and the quick actions that
 * serve the selected row.
 *
 * The pagination is the server's (S3): the chips and the class filter describe
 * the whole catalogue, so only the backend can answer them while the browser
 * holds one page. Each row arrives already classified by
 * `domain.library_class`, which is why this file never guesses a class.
 *
 * Selection is the only thing the page owns. The row selects — clicking it, or
 * `Espacio` — and the chevron `›` (or `Enter`) opens the detail. This component
 * stays mounted while the detail is open and is hidden by its parent, so the
 * chips, the search, the page and the scroll are all still there on the way
 * back (S8).
 */

const PAGE_SIZE = 50

const CLASS_CHIPS = ['sin archivo', '4K', '3D', '1080', 'otros'] as const

const CLASS_LABELS: Record<string, string> = {
  'sin archivo': 'Sin archivo',
  '4K': '4K',
  '3D': '3D',
  '1080': '1080',
  otros: 'Otros',
}

interface MoviesPage extends PaginatedResponse<AllMovie> {
  /** The chips' counts over the whole catalogue, `todos` first. */
  counts?: Record<string, number>
  /** `AllMovie` plus the class the backend already decided. */
  items: (AllMovie & { class?: string })[]
}

async function fetchMovies(
  page: number,
  className: string,
  query: string,
): Promise<MoviesPage> {
  const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) })
  if (className) params.set('class', className)
  if (query) params.set('q', query)
  const res = await apiFetch(`/api/wanted/all?${params.toString()}`, {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as MoviesPage & { error?: string }
  return { ...body, items: body.items ?? [] }
}

function movieDetail(movie: AllMovie & { class?: string }): MediaDetail {
  const meta: { label: string; value: string }[] = []
  if (movie.year != null) meta.push({ label: 'Año', value: String(movie.year) })
  meta.push({ label: 'Clase', value: CLASS_LABELS[movie.class ?? ''] ?? (movie.class || '—') })
  meta.push({ label: 'Calidad', value: movie.quality || '—' })
  meta.push({ label: 'Ruta', value: movie.path || '—' })
  return {
    title: movie.title,
    poster: movie.remotePoster || undefined,
    meta,
    grab: formatGrabMark(movie.grabbed_at, movie.grabbed_destination) ?? undefined,
  }
}

function movieRelease(movie: AllMovie): ReleaseSearchItem {
  return {
    type: 'movie',
    id: movie.id,
    title: movie.title,
    year: movie.year,
    source: 'radarr',
    remotePoster: movie.remotePoster,
    has_file: movie.has_file,
    idKind: 'movie',
  }
}

/** The resolutions the row always names, lit or not — the design's vocabulary,
 *  not the five buckets the chips on top filter by. */
const RESOLUTIONS = ['4K', '3D', '1080p', 'SD'] as const

/** What the row lights up. The backend resolved it from the disk — the file's
 *  own class plus the copies the configured roots hold — because the browser
 *  cannot look at the folders, and a guess here would be a lie on screen. */
function availableResolutions(movie: AllMovie): string[] {
  const proved = new Set(movie.libraries ?? [])
  return RESOLUTIONS.filter((label) => proved.has(label))
}

export function PeliculasV2List({
  selectedId,
  onSelect,
  onOpen,
  onReleases,
  onScan,
}: {
  selectedId: number | null
  onSelect: (selection: MediaSelection) => void
  onOpen: (selection: MediaSelection) => void
  /** The page owns both modals: opening one from here and from the detail's
   *  own menu is the same gesture, so there is a single owner of that state. */
  onReleases: (item: ReleaseSearchItem) => void
  onScan: (item: ScanItem) => void
}) {
  const [page, setPage] = useState(1)
  const [className, setClassName] = useState('')
  const [search, setSearch] = useState('')
  const debounced = useDebouncedValue(search, 350)
  const searchRef = useRef<HTMLInputElement>(null)
  const rowsRef = useRef(new Map<number, HTMLDivElement>())

  const query = useQuery({
    queryKey: ['v2-movies', page, className, debounced],
    queryFn: () => fetchMovies(page, className, debounced),
  })

  const items = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const counts = query.data?.counts ?? {}
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const selected = items.find((m) => m.id === selectedId) ?? null

  // A new filter or a new search is a new list: page 1, never a page that the
  // narrowed result set does not have.
  useEffect(() => {
    setPage(1)
  }, [className, debounced])

  // Ctrl+K puts the cursor in the design's search box from anywhere on the page.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.key !== 'k' && event.key !== 'K') || (!event.ctrlKey && !event.metaKey)) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function pick(movie: AllMovie & { class?: string }): MediaSelection {
    return { id: movie.id, detail: movieDetail(movie), release: movieRelease(movie) }
  }

  /** `↑↓` walk the list, `Espacio` selects and `Enter` opens, per the design's
   *  own legend. Both gestures keep working with the mouse on the row and the
   *  chevron. */
  function onListKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (items.length === 0) return
    const index = items.findIndex((m) => m.id === selectedId)
    const next = index < 0 ? 0 : index + (event.key === 'ArrowDown' ? 1 : -1)
    if (next < 0 || next >= items.length) return
    const movie = items[next]
    onSelect(pick(movie))
    rowsRef.current.get(movie.id)?.focus()
  }

  function runQuick(action: 'open' | 'releases' | 'scan') {
    if (!selected) return
    if (action === 'open') onOpen(pick(selected))
    if (action === 'releases') onReleases(movieRelease(selected))
    if (action === 'scan') {
      onScan({ type: 'movie', id: selected.id, title: selected.title, source: 'radarr' })
    }
  }

  function emptyMessage(): string {
    if (query.isPending) return 'Cargando títulos...'
    if (query.isError) return 'No se pudo leer el catálogo de Radarr.'
    if (counts.todos === 0) return 'No hay películas en el catálogo'
    if (debounced.trim()) return `Ninguna película coincide con «${debounced.trim()}».`
    return `Ninguna película en ${CLASS_LABELS[className] ?? className}.`
  }

  return (
    <div className="sec-v2">
      <div className="sec-l2-head">
        <div className="sec-l2-titles">
          <h2 className="sec-l2-title">Películas</h2>
          <p className="sec-l2-sub">
            {counts.todos ?? 0} {(counts.todos ?? 0) === 1 ? 'película' : 'películas'} ·{' '}
            {counts['sin archivo'] ?? 0} sin archivo
          </p>
        </div>
        <div className="sec-l2-tools">
          <div className="sec-l2-search">
            <span className="sec-l2-search-icon" aria-hidden="true">
              🔍
            </span>
            <input
              ref={searchRef}
              type="search"
              className="sec-l2-search-input"
              aria-label="Buscar película"
              placeholder="Buscar película..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <kbd className="sec-l2-kbd" aria-hidden="true">
              Ctrl+K
            </kbd>
          </div>
          <button
            type="button"
            className="sec-l2-btn"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <span aria-hidden="true">↻</span>
            {query.isFetching ? 'Actualizando…' : 'Actualizar'}
          </button>
          {/* The library's actions need no row; the row's need one, and the
              menu never guesses which (S2 of «peliculas-v2-biblioteca»). */}
          <QuickActionsMenu
            primary
            items={
              selected
                ? [
                    { label: 'Ver detalle', onSelect: () => runQuick('open') },
                    { label: 'Buscar releases', onSelect: () => runQuick('releases') },
                    { label: 'Escanear carpeta', onSelect: () => runQuick('scan') },
                  ]
                : []
            }
          >
            {selected && <hr className="sec-l2-menu-sep" />}
            <ProbeLibraryCard />
          </QuickActionsMenu>
        </div>
      </div>

      <div className="sec-class-filters" role="group" aria-label="Filtrar por clase">
        <button
          type="button"
          aria-pressed={className === ''}
          className={`sec-class-chip${className === '' ? ' is-active' : ''}`}
          onClick={() => setClassName('')}
        >
          Todas <span className="sec-class-count">{counts.todos ?? 0}</span>
        </button>
        {CLASS_CHIPS.map((cls) => (
          <button
            key={cls}
            type="button"
            aria-pressed={className === cls}
            className={`sec-class-chip${className === cls ? ' is-active' : ''}`}
            onClick={() => setClassName(cls)}
          >
            {CLASS_LABELS[cls]} <span className="sec-class-count">{counts[cls] ?? 0}</span>
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="sec-empty">{emptyMessage()}</p>
      ) : (
        <div
          className="sec-movie-list"
          role="list"
          aria-label="Películas"
          onKeyDown={onListKeyDown}
        >
          {items.map((movie) => {
            const have = availableResolutions(movie)
            const isSelected = movie.id === selectedId
            return (
              <div
                key={movie.id}
                role="listitem"
                data-movie-id={movie.id}
                ref={(node) => {
                  if (node) rowsRef.current.set(movie.id, node)
                  else rowsRef.current.delete(movie.id)
                }}
                className={`sec-movie-row${isSelected ? ' is-selected' : ''}`}
                tabIndex={0}
                aria-current={isSelected ? 'true' : undefined}
                onClick={() => onSelect(pick(movie))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    onOpen(pick(movie))
                  } else if (event.key === ' ') {
                    event.preventDefault()
                    onSelect(pick(movie))
                  }
                }}
              >
                {movie.remotePoster ? (
                  <img className="sec-movie-poster" src={movie.remotePoster} alt="" loading="lazy" />
                ) : (
                  <span className="sec-movie-poster" aria-hidden="true" />
                )}
                <span className="sec-movie-main">
                  <span className="sec-movie-titlerow">
                    <span className="sec-movie-title">{movie.title}</span>
                    {isSelected && <span className="sec-selected-tag">Seleccionado</span>}
                  </span>
                  <span className="sec-movie-sub">
                    {movie.year ?? '—'} · {movie.quality || '—'}
                  </span>
                  <span className="sec-movie-path" title={movie.path || undefined}>
                    {movie.path || '—'}
                  </span>
                </span>
                <span className="sec-movie-side">
                  {movie.has_file === false && (
                    <span className="sec-class-badge is-missing">Sin archivo</span>
                  )}
                  <span className="sec-movie-res">
                    {RESOLUTIONS.map((label) => (
                      <span
                        key={label}
                        className={`sec-res-chip${have.includes(label) ? ' is-on' : ''}`}
                      >
                        {label}
                      </span>
                    ))}
                  </span>
                  <button
                    type="button"
                    className="sec-movie-open"
                    aria-label={`Abrir ${movie.title}`}
                    onClick={(event) => {
                      // S4: only the chevron opens. The row body selects — that
                      // is what the quick actions act on.
                      event.stopPropagation()
                      onOpen(pick(movie))
                    }}
                  >
                    ›
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      )}

      <footer className="sec-v2-foot">
        <div className="sec-v2-foot-left">
          <span className="sec-v2-shown">
            Mostrando {items.length} de {total}
          </span>
          <span className="sec-v2-keys">
            <kbd>↑↓</kbd> Navegar <kbd>Enter</kbd> Detalle <kbd>Espacio</kbd> Selección
          </span>
        </div>
        <div className="sec-v2-pager">
          <span>
            Pág {page} de {pages}
          </span>
          <button
            type="button"
            aria-label="Página anterior"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Página siguiente"
            disabled={page >= pages}
            onClick={() => setPage((current) => Math.min(pages, current + 1))}
          >
            ›
          </button>
        </div>
      </footer>

      {/* Its own feature, kept reachable: the mock has no room for it, so it
          sits below the list instead of pushing the design's header down. */}
      <QualityBelowList />

    </div>
  )
}
