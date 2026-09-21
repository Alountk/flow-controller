import { useEffect, useState } from 'react'

/**
 * Delay a rapidly-changing value.
 *
 * The wanted listing filter hits the backend, where a text filter makes the
 * server pull the entire wanted list before filtering. Without debouncing that
 * would happen on every keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
