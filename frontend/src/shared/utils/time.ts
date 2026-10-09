/** "hace 21 min" for an ISO date — the age every surface shows for a row. */
export function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const diff = Date.now() - then
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'ahora'
  if (mins < 60) return `hace ${mins} min`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `hace ${hours} h`
  return `hace ${Math.round(hours / 24)} d`
}
