import type { Release } from '../api/calendar'
import { textIncludes } from './text'

/**
 * Client-side filters for the indexer release list.
 *
 * The release list arrives complete in a single response (it is not paginated),
 * so filtering here cannot hide entries that were never loaded — the same reason
 * it is honest on scan results and dishonest on the paginated wanted listing.
 */
export interface ReleaseFilters {
  /** Matches the release title. */
  text: string
  /** Empty means "any quality". */
  qualities: ReadonlySet<string>
  /** Empty means "any language". A release matching ANY selected language passes. */
  languages: ReadonlySet<string>
  /** 0 means "no minimum". */
  minSeeders: number
}

export const NO_RELEASE_FILTERS: ReleaseFilters = {
  text: '',
  qualities: new Set<string>(),
  languages: new Set<string>(),
  minSeeders: 0,
}

/** Selection key for releases: the guid. */
export const releaseKey = (release: Release): string => release.guid

/** Whether any filter is narrowing the list. */
export function hasActiveFilters(filters: ReleaseFilters): boolean {
  return (
    filters.text.trim() !== '' ||
    filters.qualities.size > 0 ||
    filters.languages.size > 0 ||
    filters.minSeeders > 0
  )
}

/**
 * Apply every filter. Filters combine with AND across dimensions, and OR within
 * a multi-select: "Bluray-1080p or WEBDL-1080p, in English or Spanish".
 */
export function filterReleases(
  releases: readonly Release[],
  filters: ReleaseFilters,
): Release[] {
  const needle = filters.text.trim()

  return releases.filter((release) => {
    if (needle && !textIncludes(release.title, needle)) return false
    if (filters.qualities.size > 0 && !filters.qualities.has(release.quality)) return false
    if (
      filters.languages.size > 0 &&
      !release.languages.some((language) => filters.languages.has(language))
    ) {
      return false
    }
    if (release.seeders < filters.minSeeders) return false
    return true
  })
}

/**
 * Every quality present in the results, sorted.
 *
 * Derived from the FULL result set, never the filtered one: options that vanish
 * as you filter make the control feel broken.
 */
export function collectQualities(releases: readonly Release[]): string[] {
  return [...new Set(releases.map((release) => release.quality))].sort()
}

/** Every language present in the results, sorted. Derived from the full set. */
export function collectLanguages(releases: readonly Release[]): string[] {
  return [...new Set(releases.flatMap((release) => release.languages))].sort()
}

/** Toggle a value in a filter set, returning a new set. */
export function toggleInSet(values: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(values)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}
