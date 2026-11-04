import { looksThreeD } from './threeD.ts'
import { fromName, type MeasuredClass } from './resolution.ts'

/**
 * T3 (S1/S4): which section a file belongs to — 3D > 4K > 1080 > SD > Otros.
 * Only proofs count: a measurement, the name's own tokens, or membership in the
 * routing folders. A file that states nothing and lives in the movie's folder is
 * the library default (1080 — the S3 preview shows a tokenless file there);
 * anything else proves no class and stays visible under Otros (S4).
 *
 * `SD` is its own section because "we know it is small" is an answer, and it used
 * to be buried in Otros together with "we know nothing".
 */

export type FileSectionId = '1080' | '4k' | '3d' | 'sd' | 'otros'

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

/** Measured class -> section. Anything measured below 1080 is SD. */
const MEASURED_SECTION: Record<string, FileSectionId> = {
  '2160': '4k',
  '1080': '1080',
  '720': 'sd',
  '576': 'sd',
  '480': 'sd',
}

export function classifyFile(
  entry: { name: string; path: string; is_dir?: boolean; is_video?: boolean },
  folders: RoutingFolders,
  basePath: string,
  measured?: MeasuredClass,
): FileSectionId {
  // Subtitles and directories prove nothing (holdsCopy's rule); ffprobe
  // cannot read them either, so they never claim a class.
  if (entry.is_dir || entry.is_video === false) return 'otros'
  if (looksThreeD(entry.name)) return '3d'
  if (inFolder(entry.path, folders.path3d)) return '3d'
  if (inFolder(entry.path, folders.path4k)) return '4k'
  // A measurement beats the name, the same precedence the backend applies: a
  // file named 720p that probed 1920×800 is a 1080 file.
  if (measured) return MEASURED_SECTION[measured] ?? 'sd'
  const declared = MEASURED_SECTION[fromName(entry.name)]
  if (declared) return declared
  if (inFolder(entry.path, basePath)) return '1080'
  return 'otros'
}
