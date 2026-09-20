import type { ScanMatch } from '../types'

/** Case- and accent-insensitive compare, so "Seu Nome" matches "seu nome". */
export function normalizeForFilter(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

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
  const needle = normalizeForFilter(query)
  if (!needle) return matches

  return matches.filter((match) =>
    searchableFields(match).some((field) => normalizeForFilter(field ?? '').includes(needle))
  )
}

/**
 * Whether every currently visible match is selected.
 *
 * `visible.length === 0` is never "all selected": with nothing on screen the
 * select-all control is hidden and offering to deselect nothing is meaningless.
 */
export function areAllVisibleSelected(
  selected: ReadonlySet<string>,
  visible: ScanMatch[],
): boolean {
  return visible.length > 0 && visible.every((match) => selected.has(match.file_path))
}

/**
 * Compute the next selection when the select-all control is toggled.
 *
 * Only touches visible matches. Acting on filter-hidden rows would move files
 * the user cannot see, which is exactly the bug this guards against.
 */
export function toggleVisibleSelection(
  selected: ReadonlySet<string>,
  visible: ScanMatch[],
): Set<string> {
  const next = new Set(selected)
  const allSelected = areAllVisibleSelected(selected, visible)

  for (const match of visible) {
    if (allSelected) next.delete(match.file_path)
    else next.add(match.file_path)
  }

  return next
}
