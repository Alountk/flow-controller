import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Peliculas } from '../components/Peliculas'
import { Series } from '../components/Series'

/**
 * One file for both sections: Películas and Series are twins by design (the
 * chosen master–detail prototypes), so the shell they share is asserted once
 * per section from the same expectations.
 *
 * Since PR 2 the panes fetch real content, so every render goes through a
 * QueryClientProvider and a fetch stub that answers with empty listings: the
 * sub-views that no longer promise content are asserted against the pane's own
 * states, and the PR notes are asserted only where they still exist.
 */

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

/** Empty listings: this file asserts the shell, not the pane's row rendering. */
function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/wanted/series/all')) {
        return ok({ items: [], total: 0, page: 1, page_size: 50 })
      }
      if (url.includes('/api/wanted/all')) {
        return ok({ items: [], total: 0, page: 1, page_size: 50 })
      }
      if (url.includes('/api/wanted?')) {
        return ok({
          wanted: { radarr: { items: [], total: 0 }, sonarr: { items: [], total: 0 } },
          updated_at: 0,
        })
      }
      return ok({})
    }),
  )
}

function renderSection(Component: ComponentType) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  )
}

interface SectionCase {
  title: string
  Component: ComponentType
  detailTabs: string[]
  /** The pane's own empty state for the catalogue (Biblioteca, filter "Todas"). */
  catalogEmpty: string
}

/** The exact copy each sub-view still WAITING for content must show. */
const SUB_VIEW_MESSAGES: Record<string, string> = {
  Estrenos:
    'Llega con el PR 3: se mueve desde Calendario, y el modal de releases pasa a panel de detalle.',
  Calidad: 'Llega con el PR 3.',
}

/** Biblioteca and Faltantes had a PR-2 promise; PR 2 delivered it. */
const DELIVERED_PROMISES = /Llega con el PR 2/

const PANEL_EMPTY = 'Selecciona un elemento de la lista para ver su detalle.'

const SECTION_CASES: SectionCase[] = [
  {
    title: 'Películas',
    Component: Peliculas,
    detailTabs: ['Releases', 'Archivos', 'Historial'],
    catalogEmpty: 'No hay películas en el catálogo',
  },
  {
    title: 'Series',
    Component: Series,
    detailTabs: ['Episodios', 'Releases', 'Archivos'],
    catalogEmpty: 'No hay series en el catálogo',
  },
]

SECTION_CASES.forEach(({ title, Component, detailTabs, catalogEmpty }) => {
  describe(title, () => {
    beforeEach(() => {
      // The pane's search lives in the URL hash; each test starts clean.
      window.location.hash = ''
      mockFetch()
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('renders the section heading', () => {
      renderSection(Component)

      expect(screen.getByRole('heading', { level: 2, name: title })).toBeInTheDocument()
    })

    it('offers the four sub-view tabs and switches the visible content', async () => {
      renderSection(Component)

      const tabs = screen.getAllByRole('tab')
      expect(tabs.map((t) => t.textContent)).toEqual([
        'Biblioteca',
        'Faltantes',
        'Estrenos',
        'Calidad',
      ])

      // Biblioteca is the default view, and since PR 2 it shows the pane's own
      // list state instead of a promise of content.
      expect(await screen.findByText(catalogEmpty)).toBeInTheDocument()
      expect(screen.queryByText(DELIVERED_PROMISES)).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))
      expect(screen.getByText(SUB_VIEW_MESSAGES['Estrenos'])).toBeInTheDocument()
      expect(screen.queryByText(catalogEmpty)).not.toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Estrenos' })).toHaveAttribute(
        'aria-selected',
        'true',
      )
      expect(screen.getByRole('tab', { name: 'Biblioteca' })).toHaveAttribute(
        'aria-selected',
        'false',
      )

      fireEvent.click(screen.getByRole('tab', { name: 'Calidad' }))
      expect(screen.getByText(SUB_VIEW_MESSAGES['Calidad'])).toBeInTheDocument()
      expect(screen.queryByText(SUB_VIEW_MESSAGES['Estrenos'])).not.toBeInTheDocument()
    })

    it('renders the master–detail frame with its columns and its panel', async () => {
      renderSection(Component)
      await screen.findByText(catalogEmpty)

      // The column frame belongs to the sub-views still waiting for content;
      // Biblioteca and Faltantes hold the pane's rows since PR 2.
      fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))

      const master = screen.getByRole('tabpanel')
      const headers = within(master).getAllByRole('columnheader').map((el) => el.textContent)
      expect(headers).toEqual(['Título', 'Año', 'Estado', 'Calidad', 'Ruta'])

      const panel = screen.getByRole('region', { name: 'Panel de detalle' })
      for (const tab of detailTabs) {
        expect(within(panel).getByRole('button', { name: tab })).toBeInTheDocument()
      }
      expect(within(panel).getByRole('heading', { name: 'Sin selección' })).toBeInTheDocument()
    })

    it('names the PR that brings the content only where content is still missing', async () => {
      renderSection(Component)

      for (const [label, message] of Object.entries(SUB_VIEW_MESSAGES)) {
        fireEvent.click(screen.getByRole('tab', { name: label }))
        expect(screen.getByText(message)).toBeInTheDocument()
        expect(message).toMatch(/PR [1-4]/)
      }

      // PR 2 delivered Biblioteca and Faltantes: they no longer promise.
      for (const label of ['Biblioteca', 'Faltantes']) {
        fireEvent.click(screen.getByRole('tab', { name: label }))
        expect(screen.queryByText(DELIVERED_PROMISES)).not.toBeInTheDocument()
      }

      expect(screen.getByText(PANEL_EMPTY)).toBeInTheDocument()
    })

    it('renders the destination and quality controls disabled', async () => {
      renderSection(Component)
      await screen.findByText(catalogEmpty)

      expect(screen.getByLabelText('Carpeta de destino')).toBeDisabled()

      for (const quality of ['1080p', '4K', '3D']) {
        expect(screen.getByRole('button', { name: quality })).toBeDisabled()
      }

      expect(screen.getByRole('button', { name: 'Descargar en esta carpeta' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Buscar otra vez' })).toBeDisabled()

      const panel = screen.getByRole('region', { name: 'Panel de detalle' })
      for (const tab of detailTabs) {
        expect(within(panel).getByRole('button', { name: tab })).toBeDisabled()
      }
    })

    it('shows the four-PR roadmap from the page itself', () => {
      renderSection(Component)

      const heading = screen.getByRole('heading', { level: 3, name: 'Notas de implementación' })
      const list = heading.nextElementSibling as HTMLElement
      expect(list.tagName).toBe('OL')
      for (const pr of ['PR 1', 'PR 2 (este)', 'PR 3', 'PR 4']) {
        expect(list.textContent).toContain(pr)
      }
    })
  })
})
