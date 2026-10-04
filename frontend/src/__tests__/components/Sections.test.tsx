import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Peliculas } from '../../components/Peliculas'
import { Series } from '../../components/Series'

/**
 * One file for both sections: Películas and Series are twins by design (the
 * chosen master–detail prototypes), so the shell they share is asserted once
 * per section from the same expectations.
 *
 * Since PR 2 the panes fetch real content, so every render goes through a
 * QueryClientProvider and a fetch stub that answers with empty listings: the
 * sub-views that no longer promise content are asserted against the pane's own
 * states, and the PR notes are asserted only where they still exist. Since
 * PR 3 Estrenos renders the real calendar (empty under this stub), and since
 * PR 4 Calidad renders the real class list, no sub-view is still waiting.
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
      // PR 3: Estrenos mounts the calendar, which asks for its date range.
      if (url.includes('/api/calendar?')) {
        return ok({ items: [], start: '2026-10-02', end: '2026-11-01' })
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

/** The exact copy each sub-view still WAITING for content must show.
 *  None is waiting any more: PR 3 filled Estrenos, PR 4 filled Calidad. */
const SUB_VIEW_MESSAGES: Record<string, string> = {}

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
    detailTabs: ['Episodios', 'Releases', 'Archivos', 'Historial'],
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
      // PR 3: the calendar renders INSIDE the list column, and the sub-view
      // no longer promises content it now has.
      expect(
        within(screen.getByRole('tabpanel')).getByRole('heading', {
          level: 2,
          name: 'Calendario',
        }),
      ).toBeInTheDocument()
      expect(screen.queryByText(/Llega con el PR 3/)).not.toBeInTheDocument()
      expect(screen.queryByText(catalogEmpty)).not.toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Panel de detalle' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Estrenos' })).toHaveAttribute(
        'aria-selected',
        'true',
      )
      expect(screen.getByRole('tab', { name: 'Biblioteca' })).toHaveAttribute(
        'aria-selected',
        'false',
      )

      fireEvent.click(screen.getByRole('tab', { name: 'Calidad' }))
      // PR 4: Calidad renders the real class list (empty under this stub),
      // not the promise of content it used to show.
      expect(
        await within(screen.getByRole('tabpanel')).findByRole('group', {
          name: 'Filtrar por clase',
        }),
      ).toBeInTheDocument()
      expect(screen.queryByText('Llega con el PR 4.')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('heading', { level: 2, name: 'Calendario' }),
      ).not.toBeInTheDocument()
    })

    it('renders the master–detail frame with its columns and its panel', async () => {
      renderSection(Component)
      await screen.findByText(catalogEmpty)

      // Since PR 4 the Calidad tab holds the real class table, so its columns
      // are the frame this test reads: Biblioteca and Faltantes hold the
      // pane's rows, Estrenos the calendar. Under this stub the catalogue is
      // empty, and that empty state must live INSIDE the table, not instead
      // of it.
      fireEvent.click(screen.getByRole('tab', { name: 'Calidad' }))
      expect(await screen.findByText(catalogEmpty)).toBeInTheDocument()

      const master = screen.getByRole('tabpanel')
      const headers = within(master).getAllByRole('columnheader').map((el) => el.textContent)
      expect(headers).toEqual(['Título', 'Año', 'Clase', 'Calidad', 'Ruta', 'Enrutado'])

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

      // PR 3 delivered Estrenos: it renders the calendar and promises no PR.
      fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))
      expect(screen.queryByText(/Llega con el PR/)).not.toBeInTheDocument()

      // PR 2 delivered Biblioteca and Faltantes: they no longer promise.
      for (const label of ['Biblioteca', 'Faltantes']) {
        fireEvent.click(screen.getByRole('tab', { name: label }))
        expect(screen.queryByText(DELIVERED_PROMISES)).not.toBeInTheDocument()
      }

      expect(screen.getByText(PANEL_EMPTY)).toBeInTheDocument()
    })

    it('replaces the placeholder action controls with the live Releases tab', async () => {
      renderSection(Component)
      await screen.findByText(catalogEmpty)

      // PR 5: the mock-up controls are gone. The real quality chips,
      // destination combo and download buttons live inside the Releases tab
      // (they render with a selection), so leaving two sets here would make
      // the panel contradict itself.
      expect(screen.queryByLabelText('Carpeta de destino')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Descargar en esta carpeta' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Buscar otra vez' })).not.toBeInTheDocument()
      for (const quality of ['1080p', '4K', '3D']) {
        expect(screen.queryByRole('button', { name: quality })).not.toBeInTheDocument()
      }

      const panel = screen.getByRole('region', { name: 'Panel de detalle' })
      // PR 6 fills the remaining tabs, so every one of them is live now:
      // none stays a disabled placeholder behind Releases.
      for (const tab of detailTabs) {
        expect(within(panel).getByRole('button', { name: tab })).toBeEnabled()
      }
    })

    it('shows the seven-PR roadmap from the section itself', () => {
      renderSection(Component)

      const heading = screen.getByRole('heading', { level: 3, name: 'Notas de implementación' })
      const list = heading.nextElementSibling as HTMLElement
      expect(list.tagName).toBe('OL')
      for (const pr of ['PR 1', 'PR 2', 'PR 3', 'PR 4', 'PR 5', 'PR 6', 'PR 7 (este)']) {
        expect(list.textContent).toContain(pr)
      }
      // The stale marker follows the plan: the token moved with each PR and
      // now sits on PR 7, the last of the chain.
      expect(list.textContent).not.toContain('PR 6 (este)')
      expect(list.textContent).not.toContain('PR 4 (este)')
      // The chain is complete: every PR delivered ✅, none pending ⬜.
      expect(list.textContent).toContain('✅')
      expect(list.textContent).not.toContain('⬜')
    })
  })
})
