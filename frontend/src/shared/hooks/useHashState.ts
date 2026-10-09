import { useState, useCallback, useEffect } from 'react'

function parseHash(): Record<string, string> {
  const hash = window.location.hash.replace(/^#\/?/, '')
  if (!hash) return {}
  const params = new URLSearchParams(hash.split('?')[1] || '')
  const result: Record<string, string> = {}
  params.forEach((v, k) => { result[k] = v })
  return result
}

function buildHash(base: string, params: Record<string, string>): string {
  const sp = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v) sp.set(k, v)
  })
  const qs = sp.toString()
  return qs ? `#/${base}?${qs}` : `#/${base}`
}

export function useHashState<T extends string>(
  section: string,
  key: string,
  defaultValue: T,
): [T, (value: T) => void] {
  const [state, setState] = useState<T>(() => {
    const params = parseHash()
    return (params[key] as T) || defaultValue
  })

  const setValue = useCallback((value: T) => {
    setState(value)
    const params = parseHash()
    if (value === defaultValue) {
      delete params[key]
    } else {
      params[key] = value
    }
    window.location.hash = buildHash(section, params)
  }, [section, key, defaultValue])

  useEffect(() => {
    function onHashChange() {
      const params = parseHash()
      const next = (params[key] as T) || defaultValue
      setState((prev) => (prev !== next ? next : prev))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [key, defaultValue])

  return [state, setValue]
}
