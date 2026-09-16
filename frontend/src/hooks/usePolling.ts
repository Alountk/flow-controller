import { useCallback, useEffect, useRef, useState } from 'react'

interface UsePollingOptions {
  /** Intervalo ms entre el fin de una petición y el inicio de la siguiente */
  intervalMs?: number
  /** Máximo de fallos consecutivos antes de backoff */
  maxConsecutiveErrors?: number
}

export interface UsePollingResult<T> {
  data: T | null
  error: string | null
  loading: boolean
  lastUpdated: number | null
  /** Fuerza un refresco inmediato, reiniciando el ciclo. */
  refresh: () => void
}

/**
 * Hook de polling sin solapamiento.
 *
 * A diferencia de setInterval, la siguiente petición SOLO se agenda
 * después de que la anterior se haya resuelto (éxito o error).
 * Esto evita que se acumulen llamadas concurrentes cuando el backend
 * tarda más que el intervalo.
 */
export function usePolling<T>(
  url: string,
  options: UsePollingOptions = {},
): UsePollingResult<T> {
  const { intervalMs = 5000, maxConsecutiveErrors = 5 } = options

  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  const errorsRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const refresh = useCallback(() => setRefreshTick((v) => v + 1), [])

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>

    async function poll() {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      try {
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as T
        if (!active) return

        errorsRef.current = 0
        setData(json)
        setError(null)
        setLastUpdated(Date.now())
      } catch (e) {
        if (!active || (e as Error).name === 'AbortError') return
        errorsRef.current += 1
        setError((e as Error).message)
      } finally {
        if (active) setLoading(false)
      }

      if (!active) return

      // Backoff progresivo si hay fallos consecutivos, normal si no.
      const backoff =
        errorsRef.current > 0
          ? Math.min(intervalMs * 2 ** Math.min(errorsRef.current, maxConsecutiveErrors), 60000)
          : intervalMs

      timer = setTimeout(poll, backoff)
    }

    poll()

    return () => {
      active = false
      clearTimeout(timer)
      abortRef.current?.abort()
    }
  }, [url, intervalMs, maxConsecutiveErrors, refreshTick])

  return { data, error, loading, lastUpdated, refresh }
}
