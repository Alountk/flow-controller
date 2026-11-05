import { useState, useCallback, useEffect } from 'react'

export type Page =
  | 'dashboard'
  | 'peliculas'
  | 'peliculasV2'
  | 'series'
  | 'estrenos'
  | 'seguimiento'
  | 'disk'
  | 'files'
  | 'renombrar'
  | 'duplicados'
  | 'mixer'
  | 'config'
  | 'prototypes'

/** Single owner of the page → path map: the sidebar reads it, the router derives from it. */
export const PAGE_PATHS: Record<Page, string> = {
  dashboard: '/dashboard',
  peliculas: '/peliculas',
  peliculasV2: '/peliculas-v2',
  series: '/series',
  estrenos: '/estrenos',
  seguimiento: '/seguimiento',
  disk: '/disco',
  files: '/archivos',
  renombrar: '/renombrar',
  duplicados: '/duplicados',
  mixer: '/mixer',
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

/**
 * A page opening ANOTHER page with a parameter. `setPage` lives in App and
 * pushState fires no event by itself, so this emits the popstate the route
 * hook listens to — the URL and the rendered page stay in agreement.
 */
export function navigateTo(page: Page, hash?: string): void {
  history.pushState(null, '', PAGE_PATHS[page] + (hash ?? ''))
  window.dispatchEvent(new PopStateEvent('popstate'))
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
