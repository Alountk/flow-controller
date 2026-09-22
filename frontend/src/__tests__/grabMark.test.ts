import { describe, it, expect } from 'vitest'
import { formatGrabMark } from '../utils/grabMark'

/**
 * The shared "descarga pedida" label.
 *
 * It is the one place the date is formatted, and it returns null when there is
 * no timestamp so every surface can render nothing at all for an unmarked item.
 */

// Noon UTC on 19 September 2026, so the local date is the same in any timezone.
const GRABBED_AT = Date.UTC(2026, 8, 19, 12, 0, 0) / 1000

/** The exact label, computed the same local way the helper does. */
function expectedLabel(ts: number): string {
  const d = new Date(ts * 1000)
  return `Pedida el ${d.getDate()} sep ${d.getFullYear()}`
}

describe('formatGrabMark', () => {
  it('formats a timestamp as "Pedida el <día> sep <año>"', () => {
    expect(formatGrabMark(GRABBED_AT)).toBe(expectedLabel(GRABBED_AT))
  })

  it('returns null when there is no timestamp', () => {
    expect(formatGrabMark(null)).toBeNull()
    expect(formatGrabMark(undefined)).toBeNull()
  })
})
