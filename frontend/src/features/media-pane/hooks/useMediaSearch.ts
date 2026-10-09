import { useHashState } from '../../../shared/hooks/useHashState.ts'
import { useDebouncedValue } from '../../../shared/hooks/useDebouncedValue.ts'

/**
 * The pane's search text: hash-backed (so a refresh keeps it, and each
 * surface's namespace keeps one search from leaking into another) plus the
 * debounce that stops the wanted listing from hitting the backend per
 * keystroke.
 */
export function useMediaSearch(namespace: string) {
  const [query, setQuery] = useHashState<string>(namespace, 'q', '')
  const debouncedQuery = useDebouncedValue(query, 350)
  return { query, setQuery, debouncedQuery }
}
