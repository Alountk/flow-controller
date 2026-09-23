// Spanish short month names, spelled out rather than read from Intl: the app is
// Spanish and the label has to read "19 sep 2026" on every runtime, while
// `toLocaleDateString('es-ES', { month: 'short' })` renders "sept" here.
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/**
 * When the download was requested and, when it did not go to the arr's library,
 * where it was sent: "Pedida el 19 sep 2026" or "Pedida el 19 sep 2026 → _manual".
 *
 * The destination is shown as its last path segment so the mark stays on one
 * line in a small card; the full path is surfaced as the element's `title` by
 * the call sites. A null/empty destination means the arr's library and renders
 * exactly the date label it rendered before this feature.
 *
 * Shared by every surface that shows the mark — Faltantes, the "Todas" cards
 * and the calendar — so the label is formatted one way and each surface renders
 * nothing at all for an unmarked item instead of repeating the decision.
 * `grabbedAt` is in unix seconds.
 */
export function formatGrabMark(
  grabbedAt: number | null | undefined,
  destination?: string | null,
): string | null {
  if (grabbedAt == null) return null
  const d = new Date(grabbedAt * 1000)
  const date = `Pedida el ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`
  if (!destination) return date
  return `${date} → ${destinationFolderName(destination)}`
}

/** The last path segment of a destination, so a long path fits the card. An
 *  empty trailing part falls back to the raw value rather than an empty label. */
function destinationFolderName(destination: string): string {
  const trimmed = destination.replace(/\/+$/, '')
  return trimmed.split('/').pop() || destination
}
