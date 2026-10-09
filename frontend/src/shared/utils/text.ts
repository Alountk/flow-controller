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
