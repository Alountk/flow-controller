import { useQuery } from '@tanstack/react-query'
import { browsePath, fetchRoots } from '../api/files.ts'

// Re-exported so the navigator family imports every helper from one place —
// the implementation stays in text.ts, never a second copy.
export { formatBytes } from '../utils/text.ts'

/** Row sizes as every navigator row shows them («1.4 GB», «—» when empty).
 *  ONE implementation: FileNavigator's rows and consumers' cards share it. */
export function formatSize(bytes: number): string {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++ }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** One row's modified date as the navigator family shows it («12 oct 2025»). */
export function formatDate(ts: number): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleDateString('es-ES', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

/** The one row-name filter: case-insensitive substring on the name only.
 *  Unfiltered keeps the same array — `filterByName(items, '') === items`. */
export function filterByName<T extends { name: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  return q ? items.filter((item) => item.name.toLowerCase().includes(q)) : items
}

/** One directory's listing. staleTime 0 keeps the listing mirroring the disk:
 *  a cache here would hide a folder a download just created. */
export function useBrowse(path: string, enabled: boolean) {
  return useQuery({
    queryKey: ['files-browse', path],
    queryFn: () => browsePath(path),
    staleTime: 0,
    enabled,
  })
}

/** The allowed roots, under the ['roots'] key every surface already browses. */
export function useRoots(enabled: boolean) {
  return useQuery({
    queryKey: ['roots'],
    queryFn: fetchRoots,
    enabled,
  })
}

/** `path` minus its last segment. A root's own entry returns '' on purpose:
 *  climbing tops out at the origins view, never at the mount holding it. */
export function parentDir(path: string, rootPaths: string[]): string {
  if (rootPaths.includes(path)) return ''
  return path.split('/').slice(0, -1).join('/')
}
