export interface EpisodeTag {
  season: number
  episode: number
}

export interface EpisodeInfo {
  season: number
  episode: number
  title?: string | null
  air_date?: string | null
}

/** Map key for an episode, e.g. "S03E07". */
export function episodeTagKey(season: number, episode: number): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `S${pad(season)}E${pad(episode)}`
}

// `S03E07`, `s3e7`, `S03.E07`, `S03-E07`, `S03 E07`.
const SEASON_EPISODE = /[Ss](\d{1,2})[\s._-]?[Ee](\d{1,2})(?!\d)/

// `3x07`, `03x07`. The lookarounds are what keep a resolution such as
// `1920x1080` out: the season digits cannot be preceded by another digit, so
// the "20x10" hidden inside that resolution is never read as an episode.
const CROSS = /(?<!\d)(\d{1,2})[xX](\d{1,2})(?!\d)/

/**
 * Pull the season/episode number out of a release file name.
 *
 * File names spell this every way there is, and some forms are traps: a
 * resolution like 1920x1080 looks like the "3x07" shape. Only unambiguous tags
 * are accepted, and a miss returns null so the caller shows the plain name
 * instead of a wrong episode.
 */
export function parseEpisodeTag(fileName: string): EpisodeTag | null {
  if (!fileName) return null

  const seasonEpisode = SEASON_EPISODE.exec(fileName)
  const cross = CROSS.exec(fileName)
  // Return the FIRST match in the name, whichever spelling it uses.
  const match =
    seasonEpisode && cross
      ? (seasonEpisode.index <= cross.index ? seasonEpisode : cross)
      : (seasonEpisode ?? cross)

  if (!match) return null
  return { season: Number(match[1]), episode: Number(match[2]) }
}

/** "S03E07 · Of Ice Men · 2006-11-27", omitting whatever is unknown. */
export function formatEpisodeLabel(info: EpisodeInfo): string {
  const parts = [episodeTagKey(info.season, info.episode)]
  if (info.title) parts.push(info.title)
  if (info.air_date) parts.push(info.air_date.slice(0, 10))
  return parts.join(' · ')
}
