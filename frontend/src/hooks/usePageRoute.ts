import { useState, useCallback, useEffect } from 'react'

type Page = 'dashboard' | 'trace' | 'wanted' | 'calendar' | 'files' | 'config' | 'prototypes'

const PAGE_PATHS: Record<Page, string> = {
  dashboard: '/dashboard',
  trace: '/trazabilidad',
  wanted: '/faltantes',
  calendar: '/calendario',
  files: '/archivos',
  config: '/configuracion',
  prototypes: '/prototipos',
}

const PATH_PAGES: Record<string, Page> = Object.fromEntries(
  Object.entries(PAGE_PATHS).map(([page, path]) => [path, page as Page]),
)

function resolvePage(): Page {
  const path = window.location.pathname
  return PATH_PAGES[path] || 'dashboard'
}

export function usePageRoute(): [Page, (page: Page) => void] {
  const [page, setPageState] = useState<Page>(resolvePage)

  const setPage = useCallback((page: Page) => {
    const path = PAGE_PATHS[page]
    if (window.location.pathname === path) return
    history.pushState(null, '', path)
    setPageState(page)
  }, [])

  useEffect(() => {
    function onPopState() {
      setPageState(resolvePage())
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  return [page, setPage]
}
