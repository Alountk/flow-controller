import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import { Peliculas } from '../components/Peliculas'
import { Series } from '../components/Series'

/**
 * One file for both sections: Películas and Series are twins by design (the
 * chosen master–detail prototypes), so the shell they share is asserted once
 * per section from the same expectations.
 */

interface SectionCase {
  title: string
  Component: ComponentType
  detailTabs: string[]
}

/** The exact copy each sub-view empty state must show. */
const SUB_VIEW_MESSAGES: Record<string, string> = {
  Biblioteca: 'Llega con el PR 2: la lista completa se mueve aquí desde Faltantes.',
  Faltantes: 'Llega con el PR 2: la cola de faltantes se mueve aquí desde Faltantes.',
  Estrenos:
    'Llega con el PR 3: se mueve desde Calendario, y el modal de releases pasa a panel de detalle.',
  Calidad: 'Llega con el PR 3.',
}

const PANEL_EMPTY = 'Selecciona un elemento de la lista — la lista llega en el PR 2.'

const SECTION_CASES: SectionCase[] = [
  { title: 'Películas', Component: Peliculas, detailTabs: ['Releases', 'Archivos', 'Historial'] },
  { title: 'Series', Component: Series, detailTabs: ['Episodios', 'Releases', 'Archivos'] },
]

SECTION_CASES.forEach(({ title, Component, detailTabs }) => {
  describe(title, () => {
    it('renders the section heading', () => {
      render(<Component />)

      expect(screen.getByRole('heading', { level: 2, name: title })).toBeInTheDocument()
    })

    it('offers the four sub-view tabs and switches the visible empty state', () => {
      render(<Component />)

      const tabs = screen.getAllByRole('tab')
      expect(tabs.map((t) => t.textContent)).toEqual([
        'Biblioteca',
        'Faltantes',
        'Estrenos',
        'Calidad',
      ])

      // Biblioteca is the default view.
      expect(screen.getByText(SUB_VIEW_MESSAGES['Biblioteca'])).toBeInTheDocument()

      fireEvent.click(screen.getByRole('tab', { name: 'Estrenos' }))
      expect(screen.getByText(SUB_VIEW_MESSAGES['Estrenos'])).toBeInTheDocument()
      expect(screen.queryByText(SUB_VIEW_MESSAGES['Biblioteca'])).not.toBeInTheDocument()
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

    it('renders the master–detail frame with its columns and its panel', () => {
      render(<Component />)

      const master = screen.getByRole('tabpanel')
      const headers = within(master).getAllByRole('columnheader').map((el) => el.textContent)
      expect(headers).toEqual(['Título', 'Año', 'Estado', 'Calidad', 'Ruta'])

      const panel = screen.getByRole('region', { name: 'Panel de detalle' })
      for (const tab of detailTabs) {
        expect(within(panel).getByRole('button', { name: tab })).toBeInTheDocument()
      }
      expect(within(panel).getByRole('heading', { name: 'Sin selección' })).toBeInTheDocument()
    })

    it('names the PR that brings the content in every empty state', () => {
      render(<Component />)

      for (const [label, message] of Object.entries(SUB_VIEW_MESSAGES)) {
        fireEvent.click(screen.getByRole('tab', { name: label }))
        expect(screen.getByText(message)).toBeInTheDocument()
        expect(message).toMatch(/PR [1-4]/)
      }

      expect(screen.getByText(PANEL_EMPTY)).toBeInTheDocument()
    })

    it('renders the destination and quality controls disabled', () => {
      render(<Component />)

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
      render(<Component />)

      const heading = screen.getByRole('heading', { level: 3, name: 'Notas de implementación' })
      const list = heading.nextElementSibling as HTMLElement
      expect(list.tagName).toBe('OL')
      for (const pr of ['PR 1 (este)', 'PR 2', 'PR 3', 'PR 4']) {
        expect(list.textContent).toContain(pr)
      }
    })
  })
})
