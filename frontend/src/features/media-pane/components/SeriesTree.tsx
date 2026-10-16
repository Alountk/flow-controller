import { Fragment, useContext, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AllSeries, DownloadEntry, SeriesEpisode } from '../../../shared/types.ts'
import { fetchSeriesEpisodes } from '../../../shared/api/wanted.ts'
import { fetchDownloads } from '../../../shared/api/downloads.ts'
import { EventStreamContext } from '../../../shared/hooks/useEventStream.ts'
import { episodeTagKey } from '../../../shared/utils/episodeTag.ts'
import {
  episodeFileState,
  episodeIdentity,
  episodeState,
  groupBySeason,
  qualityBadge,
  queueEpisodeState,
  seasonLabel,
} from '../../../shared/utils/episodeView.ts'
import { formatGrabMark } from '../../../shared/utils/grabMark.ts'
import { errorMessage } from '../../../shared/utils/text.ts'
import { SectionRow, catalogRowStatus } from './SectionRow.tsx'
import { ListingLoading, ListingError, ListingEmpty } from './ListingStates.tsx'
import { catalogSeriesDetail, catalogSeriesRelease, seriesSummary } from '../rowData.ts'
import type { ListingViewProps, ScanSeriesInput } from '../types.ts'

/**
 * The Series tree (stitch-series-tree, S2): the left list of the Series
 * section stops being a flat card grid and becomes series → season → episode.
 *
 * Each series is a COMPACT node (S2: "the tree wins" — the PR #200 cards
 * leave this view): no card frame, no poster box, no path line; the poster
 * and the path live in the detail panel. Selection, master–detail and the
 * summary lines are untouched. The node sits beside its own disclosure
 * caret, OUTSIDE the row, so expanding never selects and the
 * caret's aria-expanded is its own accessible name. A collapsed series mounts
 * no episode block at all: nothing is fetched until the disclosure opens, and
 * closing throws the block away again.
 *
 * The episodes under a series come from the EXISTENT
 * GET /api/wanted/series/{id}/episodes on demand (same query key the scan
 * modal uses). Every state there is derived only from what the payload says
 * (S5): `has_file` true/false/absent → "En biblioteca" / "Falta" / a neutral
 * dash, and the season counts add a clause only for the facts they loaded.
 *
 * T4 (S1/S5) — the queue cross: while the block is open it also reads the
 * active queue through the SAME `['downloads']` key the dashboard uses (so
 * the existing SSE invalidation refreshes this cross for free), indexed by
 * `episode_id`. The queue's word replaces the file pill ONLY for the episode
 * it names — "Descargando" / "Colocado" / the blockage it reports (S4
 * vocabulary + S5's honest extension). A failed queue read, a foreign id or
 * a state the design has no word for leaves the `has_file` pill untouched,
 * and the season counts always count files: the cross speaks through pills
 * alone. */

interface SeriesTreeProps extends ListingViewProps {
  items: AllSeries[]
  onScan: (series: ScanSeriesInput) => void
}

/** One season's summary, derived ONLY from the episodes just loaded: the
 *  total always, and each named clause only when its count is > 0 — an
 *  unknown `has_file` is neither "en biblioteca" nor "falta", it is not
 *  counted at all. */
function seasonCounts(episodes: SeriesEpisode[]): string {
  const total = episodes.length
  const inLibrary = episodes.filter((ep) => episodeFileState(ep.has_file) === 'in-library').length
  const missing = episodes.filter((ep) => episodeFileState(ep.has_file) === 'missing').length
  let counts = `${total} episodio${total === 1 ? '' : 's'}`
  if (inLibrary > 0) counts += ` · ${inLibrary} en biblioteca`
  if (missing > 0) counts += ` · ${missing} falta`
  return counts
}

/** The expanded series' episodes: one lazy query per series, mounted only
 *  while the node is open. The queue rides the same laziness — a collapsed
 *  tree reads neither. */
function SeriesEpisodes({ seriesId }: { seriesId: number }) {
  const query = useQuery({
    queryKey: ['series-episodes', seriesId],
    queryFn: () => fetchSeriesEpisodes(seriesId),
  })
  const { connected } = useContext(EventStreamContext)
  // The queue cross (T4), on the dashboard's own key: the SSE invalidation
  // and the 10 s fallback poll are shared with it. This read NEVER degrades
  // the episode block — its error is ignored on purpose: no data → the pills
  // stay on `has_file` (S5).
  const downloadsQuery = useQuery({
    queryKey: ['downloads'],
    queryFn: fetchDownloads,
    refetchInterval: connected ? false : 10000,
  })
  const queueByEpisode = useMemo(() => {
    const byEpisode = new Map<number, DownloadEntry>()
    for (const d of downloadsQuery.data?.downloads ?? []) {
      if (d.episode_id != null) byEpisode.set(d.episode_id, d)
    }
    return byEpisode
  }, [downloadsQuery.data])
  if (query.isPending) return <div className="wanted-loading">Cargando episodios…</div>
  // Two failure shapes, both reads that failed — never "no episodes".
  if (query.isError) {
    return (
      <div className="wanted-error" role="alert">
        <strong>No se pudieron leer los episodios</strong>
        <span>{errorMessage(query.error)}</span>
      </div>
    )
  }
  // The backend reports arr failures on the body: HTTP 200 with `error` is a
  // failed read, not an episode-less series.
  if (query.data.error) {
    return (
      <div className="wanted-error" role="alert">
        <strong>No se pudieron leer los episodios</strong>
        <span>{query.data.error}</span>
      </div>
    )
  }
  const episodes = query.data.episodes
  if (episodes.length === 0) {
    return (
      <div className="st-children">
        <p className="sec-tab-note">Esta serie no tiene episodios</p>
      </div>
    )
  }

  return (
    <div className="st-children">
      {groupBySeason(episodes).map(({ season, episodes: seasonEpisodes }) => (
        <Fragment key={season}>
          <div className="st-season-head">
            <span className="st-season-name">{seasonLabel(season)}</span>
            <span className="st-season-counts">{seasonCounts(seasonEpisodes)}</span>
          </div>
          {seasonEpisodes.map((ep) => {
            const state = episodeFileState(ep.has_file)
            const badge = qualityBadge(ep.quality)
            // Only an explicit `has_file` may colour the pill; unknown wears
            // the bare pill and its dash — never a state nobody reported.
            // The queue's word wins ONLY where the queue names THIS episode
            // and has a word in the S4 vocabulary (queueEpisodeState); the
            // season counts above keep counting files regardless.
            const fileTone =
              state === 'in-library' ? 'ok' : state === 'missing' ? 'bad' : ''
            const entry = ep.id != null ? queueByEpisode.get(ep.id) : undefined
            const queueState = entry ? queueEpisodeState(entry) : null
            const pill = queueState ?? { label: episodeState(ep), tone: fileTone }
            return (
              <div className="st-ep" key={episodeIdentity(ep)}>
                <span className="st-ep-code">
                  {episodeTagKey(ep.season_number ?? 0, ep.episode_number ?? 0)}
                </span>
                <span className="st-ep-name">{ep.title}</span>
                <span className={`sec-pill${pill.tone ? ` sec-pill-${pill.tone}` : ''}`}>
                  {pill.label}
                </span>
                <span className="st-ep-date">
                  {ep.air_date ? ep.air_date.slice(0, 10) : '—'}
                </span>
                {/* Absent quality is a dash, never a badge: the payload says
                    nothing, so nothing is claimed. */}
                {badge ? (
                  <span className={`sec-q-tag${badge.tone}`}>{badge.label}</span>
                ) : (
                  <span className="st-ep-qual">—</span>
                )}
                <span className="st-ep-path" title={ep.path || undefined}>
                  {ep.path || '—'}
                </span>
              </div>
            )
          })}
        </Fragment>
      ))}
    </div>
  )
}

export function SeriesTree({
  items,
  onScan,
  isPending,
  isFetchingNextPage,
  activeError,
  serviceName,
  loadMoreRef,
  rowProps,
  selectableClass,
  openReleases,
}: SeriesTreeProps) {
  // Which series' episode blocks are on screen. Collapsed = not mounted, so
  // a collapsed series never fetches anything.
  const [openSeries, setOpenSeries] = useState<Set<number>>(() => new Set())

  function toggle(id: number) {
    setOpenSeries((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (isPending) {
    return <ListingLoading message="Cargando catálogo de series..." />
  }
  if (items.length > 0) {
    return (
      <>
        <div className="st-tree">
          {items.map((series) => {
            const grabbed = formatGrabMark(series.grabbed_at, series.grabbed_destination)
            const summary = seriesSummary(series)
            const isOpen = openSeries.has(series.id)
            const actions = (
              <>
                <button
                  className="action-btn search-item"
                  onClick={() => openReleases(catalogSeriesRelease(series))}
                >
                  🔍 Buscar
                </button>
                <button
                  className="action-btn scan-folder-btn"
                  onClick={() => onScan({ id: series.id, title: series.title })}
                >
                  📁 En carpeta
                </button>
              </>
            )
            return (
              <div className="st-node" key={series.id}>
                <div className="st-head">
                  {/* The caret is a SIBLING of the row, never inside it: a
                      click here must not select the series, and aria-expanded
                      is what names this button. */}
                  <button
                    type="button"
                    className="st-caret"
                    aria-expanded={isOpen}
                    aria-label={
                      isOpen
                        ? `Contraer episodios de ${series.title}`
                        : `Mostrar episodios de ${series.title}`
                    }
                    onClick={() => toggle(series.id)}
                  >
                    ▸
                  </button>
                  <SectionRow
                    className={`wanted-card${selectableClass}`}
                    wiring={rowProps(
                      series.id,
                      () => catalogSeriesDetail(series),
                      () => catalogSeriesRelease(series),
                    )}
                    title={series.title}
                    year={series.year}
                    status={catalogRowStatus(series.has_file, series.path_exists)}
                    // S2: the compact node draws no poster box (the poster
                    // lives in the detail panel) and no path line — the path
                    // stays in the panel and on the episodes.
                    hidePoster
                    // Sonarr's list carries no quality: no chip, never a
                    // guessed one (the Calidad view says so on screen).
                    monitored={series.monitored}
                    grabbed={grabbed}
                    grabbedDestination={series.grabbed_destination}
                    extra={
                      series.episode_count > 0 ? (
                        <span className="sec-row-ep-count">
                          {series.episode_file_count}/{series.episode_count} episodios{summary.seasonSuffix}
                        </span>
                      ) : undefined
                    }
                    extraLine={
                      summary.completeness && (
                        <span
                          className={`sec-row-complete sec-row-complete-${summary.completeness.tone}`}
                        >
                          {summary.completeness.text}
                        </span>
                      )
                    }
                  >
                    {actions}
                  </SectionRow>
                </div>
                {isOpen && <SeriesEpisodes seriesId={series.id} />}
              </div>
            )
          })}
        </div>
        <div ref={loadMoreRef} className="wanted-infinite-sentinel">
          {isFetchingNextPage && <div className="wanted-loading-more">Cargando más series...</div>}
        </div>
      </>
    )
  }
  if (activeError) {
    return <ListingError serviceName={serviceName} error={activeError} />
  }
  return <ListingEmpty message="No hay series en el catálogo" />
}
