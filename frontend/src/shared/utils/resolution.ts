/**
 * S1 («umbral-calidad»): the resolution class of a MEASURED file comes from
 * its width. A 1080p transfer with cropped black bars measures 1920×800 and
 * is still a 1080p file — reading the bare height would flag every
 * widescreen movie as low quality.
 *
 * One implementation: the chip, the list and the settings slider all read it.
 */

export type ResolutionClass = 'sd' | '720p' | '1080p' | '4k' | 'desconocido'

/** The classes an operator can pick as a threshold, best last. */
export const RESOLUTION_CLASSES: ResolutionClass[] = ['sd', '720p', '1080p', '4k']

/** Slider labels, shortest first — what the Settings control shows. */
export const RESOLUTION_LABELS: Record<string, string> = {
  sd: 'SD',
  '720p': '720p',
  '1080p': '1080p',
  '4k': '4K',
}

const RANK: Record<string, number> = { desconocido: 0, sd: 1, '720p': 2, '1080p': 3, '4k': 4 }

// Widths, not heights — see the module comment. Heights are deliberately
// unused: cropped bars are not a downgrade.
const WIDTH_FLOORS: Array<[ResolutionClass, number]> = [
  ['4k', 3000],
  ['1080p', 1700],
  ['720p', 1100],
]

export function resolutionClass(width: number | null | undefined): ResolutionClass {
  if (!width || width <= 0) return 'desconocido'
  for (const [name, floor] of WIDTH_FLOORS) {
    if (width >= floor) return name
  }
  return 'sd'
}

/** Ordering for comparisons; anything unknown sinks below `sd` (never low). */
export function classRank(name: string | null | undefined): number {
  return RANK[(name ?? '').trim().toLowerCase()] ?? 0
}

/**
 * Whether a measured file sits below the configured threshold. A manual
 * `minWidth > 0` overrides the class comparison; an unmeasured file is never
 * «below» anything — it is not analyzed yet.
 */
export function isBelowThreshold(
  width: number | null | undefined,
  minClass: string,
  minWidth: number,
): boolean {
  const measured = resolutionClass(width)
  if (measured === 'desconocido') return false
  if (minWidth > 0) return (width ?? 0) < minWidth
  return classRank(measured) < classRank(minClass)
}
