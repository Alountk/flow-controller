// Spanish short month names, spelled out rather than read from Intl: the app is
// Spanish and the label has to read "19 sep 2026" on every runtime, while
// `toLocaleDateString('es-ES', { month: 'short' })` renders "sept" here.
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/**
 * When the download was requested, as "Pedida el 19 sep 2026", or null when
 * there is no timestamp.
 *
 * Shared by every surface that shows the mark — Faltantes, the "Todas" cards
 * and the calendar — so the date is formatted one way and each surface renders
 * nothing at all for an unmarked item instead of repeating the decision.
 * `grabbed_at` is in unix seconds.
 */
export function formatGrabMark(grabbedAt: number | null | undefined): string | null {
  if (grabbedAt == null) return null
  const d = new Date(grabbedAt * 1000)
  return `Pedida el ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`
}
