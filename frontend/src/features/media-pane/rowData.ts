import type { WantedMovie, WantedEpisode, AllMovie, AllSeries } from '../../shared/types.ts'
import { formatGrabMark } from '../../shared/utils/grabMark.ts'
import type { ReleaseSearchItem } from '../release-search/ReleaseSearchModal.tsx'
import type { MediaDetail } from './types.ts'

/**
 * Row data derivation: what the detail panel shows for a row and which
 * release-search item that row opens. Pure functions — the listings build
 * their payloads from the very object on screen, so the panel and the row
 * can never disagree about a title.
 */

/** Estado of a "Todas" card: the exact badge the card itself shows. */
function catalogState(
  hasFile: boolean,
  pathExists: boolean,
  hasUnimportedFile = false,
): string {
  if (hasFile && pathExists) return '✓ Configurada'
  if (!hasFile) {
    // Both statuses below claim bytes on disk, and only ONE of them we have
    // evidence for: `hasUnimportedFile` comes from the backend LISTING the
    // folder and seeing a video. "✗ Sin archivo" is Radarr's `hasFile=false`
    // (not imported) plus a check that found nothing — an unreadable NFS
    // folder reads the same as an empty one, so it stays the weaker claim.
    // The unimported one is a state, not a failure: no ✗, never an error tone.
    return hasUnimportedFile ? 'Carpetas con vídeo · sin importar' : '✗ Sin archivo'
  }
  return '✗ Ruta no encontrada'
}

function grabOf(item: { grabbed_at?: number | null; grabbed_destination?: string | null }): string | undefined {
  return formatGrabMark(item.grabbed_at, item.grabbed_destination) ?? undefined
}

function pushYear(meta: { label: string; value: string }[], year: number | null): void {
  if (year != null) meta.push({ label: 'Año', value: String(year) })
}

/** Panel data for a movie of the missing queue: the row carries no file, so
 *  its state is the queue it sits in. */
export function wantedMovieDetail(movie: WantedMovie): MediaDetail {
  const meta: { label: string; value: string }[] = []
  pushYear(meta, movie.year)
  meta.push({ label: 'Estado', value: 'Falta' })
  return { title: movie.title, poster: movie.remotePoster || undefined, meta, grab: grabOf(movie) }
}

export function catalogMovieDetail(movie: AllMovie): MediaDetail {
  const meta: { label: string; value: string }[] = []
  pushYear(meta, movie.year)
  meta.push({
    label: 'Estado',
    value: catalogState(movie.has_file, movie.path_exists, movie.has_unimported_file),
  })
  return { title: movie.title, poster: movie.remotePoster || undefined, meta, grab: grabOf(movie) }
}

export function wantedEpisodeDetail(ep: WantedEpisode): MediaDetail {
  const s = String(ep.season_number ?? 0).padStart(2, '0')
  const e = String(ep.episode_number ?? 0).padStart(2, '0')
  const meta: { label: string; value: string }[] = [
    { label: 'Episodio', value: `S${s}E${e} · ${ep.title}` },
  ]
  if (ep.air_date) meta.push({ label: 'Emitido', value: ep.air_date.slice(0, 10) })
  meta.push({ label: 'Estado', value: 'Falta' })
  return { title: ep.series_title, meta, grab: grabOf(ep) }
}

export function catalogSeriesDetail(series: AllSeries): MediaDetail {
  const meta: { label: string; value: string }[] = []
  pushYear(meta, series.year)
  meta.push({ label: 'Estado', value: catalogState(series.has_file, series.path_exists) })
  if (series.episode_count > 0) {
    meta.push({ label: 'Episodios', value: `${series.episode_file_count}/${series.episode_count} episodios` })
  }
  return { title: series.title, poster: series.remotePoster || undefined, meta, grab: grabOf(series) }
}

/** The release-search item of each row — the SAME object the overlay modal
 *  receives, so the panel's Releases tab searches exactly what the modal
 *  would have opened for that row. */
export function wantedMovieRelease(movie: WantedMovie): ReleaseSearchItem {
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

export function catalogMovieRelease(movie: AllMovie): ReleaseSearchItem {
  return {
    type: 'movie',
    id: movie.id,
    title: movie.title,
    year: movie.year,
    source: 'radarr',
    remotePoster: movie.remotePoster,
    has_file: movie.has_file,
    // The row IS where AllMovie lives, so the panel's has-file block reads the
    // file's own facts from here: its name and languages (both "" / [] when
    // the payload has none — the block degrades instead of inventing), the
    // quality behind the 1080/4K tags, and the path the 3D tag tests against
    // path_3d.
    file_name: movie.file_name,
    languages: movie.languages,
    quality: movie.quality,
    path: movie.path,
    idKind: 'movie',
  }
}

export function wantedEpisodeRelease(ep: WantedEpisode): ReleaseSearchItem {
  return {
    type: 'episode',
    id: ep.id,
    title: ep.title,
    series_title: ep.series_title,
    season_number: ep.season_number,
    episode_number: ep.episode_number,
    date: ep.air_date ? ep.air_date.slice(0, 10) : undefined,
    source: 'sonarr',
    has_file: false,
    idKind: 'episode',
  }
}

export function catalogSeriesRelease(series: AllSeries): ReleaseSearchItem {
  return {
    type: 'episode',
    id: series.id,
    title: series.title,
    series_title: series.title,
    year: series.year,
    source: 'sonarr',
    remotePoster: series.remotePoster,
    has_file: series.has_file,
    // Sonarr's list has NO per-episode file name, languages or quality — so
    // none of them travel and the block says the name is unavailable rather
    // than borrowing an episode's file as if it were the series'. The path
    // does exist, and path_3d membership is the rule PR #113 established for
    // Series, so the 3D tag can still be lit honestly.
    path: series.path,
    // The id is the SERIES', not an episode's, even though the type says
    // episode: asking the grabs history for `episode_id=<seriesId>` would
    // match whatever show owns an episode with that number — a class this
    // series never downloaded, lit as if we had it.
    idKind: 'series',
  }
}
