/** Case- and accent-insensitive compare, so "Seu Nome" matches "seu nome". */
export function normalizeForFilter(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

/**
 * Whether `haystack` contains `needle`, ignoring case and accents.
 *
 * Both sides are normalized. Normalizing only the haystack is a trap: callers
 * naturally pass raw user input, so "Todo" would fail to match "todo".
 */
export function textIncludes(haystack: string | null | undefined, needle: string): boolean {
  const normalized = normalizeForFilter(needle)
  if (!normalized) return true

  return normalizeForFilter(haystack ?? '').includes(normalized)
}

/**
 * Human-readable byte count in powers of 1024: `0` → `'0 B'`,
 * `6_710_886_400` → `'6.3 GB'` (one decimal below 100, none from 100 up).
 *
 * A display helper for a value the payload already carries — it never
 * estimates, so callers can show it under the same honesty rule as the
 * number itself.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / 1024 ** i
  return `${val.toFixed(val >= 100 ? 0 : 1)} ${units[i]}`
}
