import { looksThreeD } from './threeD.ts'

/**
 * T3 (S1/S4): which section a file belongs to — 3D > 4K > 1080 > Otros.
 * Only proofs count: the name's own tokens and membership in the routing
 * folders. A file that states nothing and lives in the movie's folder is the
 * library default (1080 — the S3 preview shows a tokenless file there);
 * anything else proves no class and stays visible under Otros (S4).
 */

export type FileSectionId = '1080' | '4k' | '3d' | 'otros'

export interface RoutingFolders {
  path4k: string
  path3d: string
}

/** True when `path` is `folder` or lives under it. An unconfigured folder ("")
 *  matches nothing: empty means "not configured", never "everything". */
function inFolder(path: string, folder: string): boolean {
  if (!path || !folder) return false
  const root = folder.endsWith('/') ? folder.slice(0, -1) : folder
  return path === root || path.startsWith(`${root}/`)
}

const FOUR_K_TOKEN = /\b(2160p|4k)\b/i
const TEN_EIGHTY_TOKEN = /\b1080[pi]\b/i
// Any OTHER stated resolution (or a DVD-era rip) proves "not 1080/4K".
const OTHER_RESOLUTION_TOKEN = /\b(360p|480p|576p|720p)\b|\bdvd/i

export function classifyFile(
  entry: { name: string; path: string; is_dir?: boolean; is_video?: boolean },
  folders: RoutingFolders,
  basePath: string,
): FileSectionId {
  // Subtitles and directories prove nothing (holdsCopy's rule); ffprobe
  // cannot read them either, so they never claim a class.
  if (entry.is_dir || entry.is_video === false) return 'otros'
  if (looksThreeD(entry.name)) return '3d'
  if (inFolder(entry.path, folders.path3d)) return '3d'
  if (inFolder(entry.path, folders.path4k)) return '4k'
  if (FOUR_K_TOKEN.test(entry.name)) return '4k'
  if (TEN_EIGHTY_TOKEN.test(entry.name)) return '1080'
  if (OTHER_RESOLUTION_TOKEN.test(entry.name)) return 'otros'
  if (inFolder(entry.path, basePath)) return '1080'
  return 'otros'
}
