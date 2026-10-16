import type { DownloadEntry, SeriesEpisode } from '../types.ts'

/**
 * Episode display vocabulary, shared by the panel's Episodios tab and the
 * series tree (Stitch bloque 🟡): one derivation of the honest file state so
 * the two surfaces can never disagree about what the payload says.
 *
 * The rule (pinned by seriesEpisodes.test.tsx): only an explicit `has_file`
 * says anything. `true` → in library, `false` → missing, absent → unknown —
 * never a state nobody reported.
 */
export type EpisodeFileState = 'in-library' | 'missing' | 'unknown'

export function episodeFileState(hasFile: boolean | undefined): EpisodeFileState {
  if (hasFile === true) return 'in-library'
  if (hasFile === false) return 'missing'
  return 'unknown'
}

/** The design's episode vocabulary (series-01-arbol: "En biblioteca" ·
 *  "Falta" · dash for unknown). The queue's own words ("Descargando" ·
 *  "Colocado") live beside it in `queueEpisodeState`, which speaks ONLY where
 *  the real queue has a word for the episode (T4, S5) — the file derivation
 *  below never learns about queues. */
export const EPISODE_STATE_LABEL: Record<EpisodeFileState, string> = {
  'in-library': 'En biblioteca',
  missing: 'Falta',
  unknown: '—',
}

/** The row's own state, as far as the payload states it: the label above,
 *  derived from the one honest derivation of the file flag. */
export function episodeState(ep: SeriesEpisode): string {
  return EPISODE_STATE_LABEL[episodeFileState(ep.has_file)]
}

/** "S03E07" — the map key for an episode, from its own numbers. */
export function episodeIdentity(ep: SeriesEpisode): string {
  return ep.id != null ? `ep:${ep.id}` : `ep:${ep.season_number ?? 0}x${ep.episode_number ?? 0}`
}

export function seasonLabel(season: number): string {
  return `Season ${String(season).padStart(2, '0')}`
}

/** Seasons in ascending order, each with the episodes that belong to it. */
export function groupBySeason(
  episodes: SeriesEpisode[],
): { season: number; episodes: SeriesEpisode[] }[] {
  const bySeason = new Map<number, SeriesEpisode[]>()
  for (const ep of episodes) {
    const season = ep.season_number ?? 0
    const group = bySeason.get(season)
    if (group) group.push(ep)
    else bySeason.set(season, [ep])
  }
  return [...bySeason.entries()]
    .sort(([a], [b]) => a - b)
    .map(([season, list]) => ({ season, episodes: list }))
}

/** A quality badge, only when the payload states a quality. 4K is the one
 *  class Sonarr's name carries that we can trust: an episode has no `is3d`, so
 *  no 3D tag is ever invented here. */
export function qualityBadge(quality: string | null): { label: string; tone: string } | null {
  if (!quality) return null
  return { label: quality, tone: quality.toLowerCase().endsWith('2160p') ? ' is-4k' : '' }
}

/** The queue's own words for one episode (T4, S4/S5), in precedence order:
 *
 *  1. a real blockage (S5's honest extension) — "Fallida" / "Import bloqueado",
 *     and for any other problem the RAW backend value, never an invented label
 *     (ActivityTable's rule);
 *  2. "Descargando" (warn) — S4 verbatim;
 *  3. "Colocado" (neutral) — S4 verbatim, the placed-but-unimported download.
 *
 *  Anything else (queued, paused, unknown…) is outside the design's vocabulary
 *  and S5 only allows the blockage extension → `null`, and the pill stays on
 *  the `has_file` fact, which is true either way. */
export function queueEpisodeState(
  entry: DownloadEntry,
): { label: string; tone: 'warn' | 'bad' | 'neutral' } | null {
  if (entry.problem === true) {
    if (entry.tracked_state === 'failed' || entry.tracked_state === 'downloadFailed') {
      return { label: 'Fallida', tone: 'bad' }
    }
    if (entry.tracked_state === 'importBlocked') {
      return { label: 'Import bloqueado', tone: 'bad' }
    }
    return { label: entry.tracked_state || entry.tracked_status, tone: 'bad' }
  }
  if (entry.status === 'downloading' || entry.tracked_state === 'downloading') {
    return { label: 'Descargando', tone: 'warn' }
  }
  if (
    entry.tracked_state === 'importPending' ||
    entry.tracked_state === 'importing' ||
    entry.status === 'completed'
  ) {
    return { label: 'Colocado', tone: 'neutral' }
  }
  return null
}
