import { useQuery } from '@tanstack/react-query'
import { browsePath, fetchRoots } from '../api/files.ts'

// Re-exported so the navigator family imports every helper from one place —
// the implementation stays in text.ts, never a second copy.
export { formatBytes } from '../utils/text.ts'

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
