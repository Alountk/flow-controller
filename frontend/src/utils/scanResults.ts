import type { ScanMatch } from '../types'
import { textIncludes } from './text'

/** Fields a filter query is matched against. */
function searchableFields(match: ScanMatch): string[] {
  return [match.file_name, match.file_path, match.matched_title, match.movie_title]
}

/**
 * Filter scan matches by a free-text query.
 *
 * The scan returns its full result set in one response (it is not paginated),
 * so filtering here cannot hide matches the user has not loaded yet.
 */
export function filterScanMatches(matches: ScanMatch[], query: string): ScanMatch[] {
  if (!query.trim()) return matches

  return matches.filter((match) =>
    searchableFields(match).some((field) => textIncludes(field, query))
  )
}

/** Selection key for scan matches: the file path. */
export const scanMatchKey = (match: ScanMatch): string => match.file_path

