/**
 * S3 («buscador-tabla»): ordering for the unified release table.
 *
 * Pure on purpose — the table renders what this returns, so the rule is
 * testable on its own. Two decisions worth knowing: rows are never mutated
 * (React state is the caller's), and a fact a row does NOT carry (no peers,
 * no languages) sinks to the bottom in BOTH directions instead of pretending
 * to be zero and stealing the top of a descending sort.
 */

export type SortKey = 'name' | 'size' | 'language' | 'peers'
export type SortDir = 'asc' | 'desc'

export interface SortState {
  key: SortKey | null
  dir: SortDir
}

export interface SortableRelease {
  title: string
  size: number
  languages?: string[]
  seeders?: number
  /** aMule's ED2K source count: the same «peers» column, another magnitude. */
  sources?: number
}

/** A click on a header: same column flips, a new column starts ascending. */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) {
    return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  }
  return { key, dir: 'asc' }
}

const languageLabel = (r: SortableRelease) => (r.languages ?? []).join(', ').toLowerCase()

/** The value a column compares, or null when the row lacks that fact. */
function valueOf(r: SortableRelease, key: SortKey): string | number | null {
  switch (key) {
    case 'name':
      return r.title.toLowerCase()
    case 'size':
      return typeof r.size === 'number' ? r.size : null
    case 'peers':
      // One column, two provenances: a torrent's seeders, else aMule's
      // ED2K sources. Both are "how many others have this", which is what the
      // header promises; a row with neither still sinks.
      return typeof r.seeders === 'number'
        ? r.seeders
        : typeof r.sources === 'number'
          ? r.sources
          : null
    case 'language': {
      const label = languageLabel(r)
      return label === '' ? null : label
    }
  }
}

export function sortReleases<T extends SortableRelease>(rows: T[], state: SortState): T[] {
  if (state.key === null) return rows
  const key = state.key
  const sign = state.dir === 'asc' ? 1 : -1

  // A copy keeps the caller's array intact (this lib predates `toSorted`);
  // the title tiebreak makes equal values deterministic.
  return [...rows].sort((a: T, b: T) => {
    const va = valueOf(a, key)
    const vb = valueOf(b, key)
    if (va === null && vb === null) return a.title.localeCompare(b.title)
    if (va === null) return 1
    if (vb === null) return -1
    const order = typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb), 'es')
    return order !== 0 ? order * sign : a.title.localeCompare(b.title)
  })
}
