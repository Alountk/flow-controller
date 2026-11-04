/**
 * The resolution of a file: ONE rule for the whole frontend.
 *
 * Two sources, and they are not equal: what a probe MEASURED and what somebody
 * WROTE in the name. A file named `720p` that measures 1920×800 is 1080 — the
 * black bars get cropped and the name keeps the transfer's original label. So
 * `best()` prefers the measurement and the name only decides when there is none.
 *
 * The thresholds mirror `backend/domain/resolution.py` exactly (Radarr's
 * `AugmentQualityFromMediaInfo`): **width OR height**, because height alone calls
 * every widescreen 4K film 1080 and width alone misses pillarboxed transfers.
 * `contracts/resolution-cases.json` is read by both suites, so a change here that
 * the backend does not share fails there.
 */

export type ResolutionClass = 'sd' | '720p' | '1080p' | '4k' | 'desconocido'

/** What a measurement can state, in the backend's vocabulary. `''` = never probed. */
export type MeasuredClass = '2160' | '1080' | '720' | '576' | '480' | ''

/** The class a measurement proves, or `''` when nothing was measured. */
export function fromDimensions(width: number | null | undefined, height: number | null | undefined): MeasuredClass {
  const w = Math.max(width ?? 0, 0)
  const h = Math.max(height ?? 0, 0)
  if (w === 0 && h === 0) return ''
  if (w >= 3200 || h >= 2100) return '2160'
  if (w >= 1800 || h >= 1000) return '1080'
  if (w >= 1200 || h >= 700) return '720'
  if (w >= 1000 || h >= 560) return '576'
  return '480'
}

const NAME_TOKENS: Array<[MeasuredClass, RegExp]> = [
  ['2160', /\b(2160p|4k)\b/i],
  ['1080', /\b1080[pi]\b/i],
  ['720', /\b720p\b/i],
  ['576', /\b576[pi]\b/i],
  ['480', /\b(480[pi]|360p)\b|\bdvd/i],
]

/** The class a name DECLARES, or `''` when it declares none. */
export function fromName(text: string | null | undefined): MeasuredClass {
  const name = text ?? ''
  for (const [cls, token] of NAME_TOKENS) {
    if (token.test(name)) return cls
  }
  return ''
}

/** The class after the precedence: the measurement if there is one, else the name. */
export function best(measured: MeasuredClass | null | undefined, name?: string | null): MeasuredClass {
  return (measured ?? '').trim() !== '' ? (measured as MeasuredClass) : fromName(name)
}

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

/** The threshold vocabulary over a measured frame — `fromDimensions` decides. */
export function resolutionClass(
  width: number | null | undefined,
  height?: number | null,
): ResolutionClass {
  const measured = fromDimensions(width, height ?? 0)
  if (measured === '') return 'desconocido'
  if (measured === '2160') return '4k'
  if (measured === '1080') return '1080p'
  if (measured === '720') return '720p'
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
