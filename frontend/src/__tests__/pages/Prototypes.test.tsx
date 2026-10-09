import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { Prototypes } from '../../pages/Prototypes.tsx'
import type { PrototypeFile } from '../../shared/types.ts'

/**
 * The gallery's whole job is answering three questions a flat tab strip could
 * not: what was chosen, what was thrown away *and why*, and what should I look
 * at first. Every test here is one of those questions.
 */

function entry(over: Partial<PrototypeFile> = {}): PrototypeFile {
  return {
    name: 'setup-02-focus-card',
    file: 'setup-02-focus-card.html',
    section: 'setup',
    status: 'unlisted',
    recommend: false,
    note: '',
    ...over,
  }
}

const CATALOGUE: PrototypeFile[] = [
  entry({
    name: 'peliculas-rejilla',
    file: 'peliculas-01-rejilla.html',
    section: 'peliculas',
    status: 'selected',
    recommend: true,
    note: 'Rejilla de carteles: escaneable y con acciones al hover.',
  }),
  entry({
    name: 'peliculas-tabla',
    file: 'peliculas-02-tabla.html',
    section: 'peliculas',
    status: 'discarded',
    note: 'Tabla densa: 40 filas sin jerarquía visual.',
  }),
  entry({
    name: 'series-arbol',
    file: 'series-01-arbol.html',
    section: 'series',
    status: 'candidate',
  }),
  entry({ name: 'stray', file: 'stray.html', section: 'otros' }),
]

function renderGallery() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ json: async () => CATALOGUE } as Response),
  )
  return render(<Prototypes />)
}

/**
 * Queries inside the cards only: the preview label repeats the selected
 * design's name on purpose, so a document-wide text query matches twice.
 */
function cards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.proto-card')]
}

function cardNamed(name: string): HTMLElement {
  const found = cards().find((c) => c.textContent?.includes(name))
  if (!found) {
    throw new Error(`no card for ${name}: ${cards().map((c) => c.textContent).join(' | ')}`)
  }
  return found
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Prototypes gallery', () => {
  it('groups the designs under their section instead of a flat tab strip', async () => {
    renderGallery()

    await waitFor(() => expect(screen.getByText('Películas')).toBeInTheDocument())

    expect(screen.getByText('Series')).toBeInTheDocument()
    expect(screen.getByText('Sin sección')).toBeInTheDocument()
  })

  it('gives the Seguimiento designs their own labelled section', async () => {
    // F-09's four prototypes carry section "seguimiento": the label and the
    // section order are what keep them together instead of under "Sin sección".
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: async () => [
          entry({
            name: 'seguimiento-alertas',
            file: 'seguimiento-04-alertas.html',
            section: 'seguimiento',
            status: 'candidate',
            recommend: true,
            note: 'Lo rojo primero.',
          }),
        ],
      } as Response),
    )
    render(<Prototypes />)

    await waitFor(() => expect(screen.getByText('Seguimiento')).toBeInTheDocument())

    expect(cardNamed('seguimiento-alertas')).toBeTruthy()
    expect(within(cardNamed('seguimiento-alertas')).getByText('★ Recomendado')).toBeInTheDocument()
  })

  it('marks what was chosen, and the one it recommends', async () => {
    renderGallery()

    await waitFor(() => expect(cardNamed('peliculas-rejilla')).toBeTruthy())

    const card = cardNamed('peliculas-rejilla')
    expect(within(card).getByText('Elegido')).toBeInTheDocument()
    expect(within(card).getByText('★ Recomendado')).toBeInTheDocument()
  })

  it('keeps the reason a design was thrown away', async () => {
    renderGallery()

    await waitFor(() => expect(cardNamed('peliculas-tabla')).toBeTruthy())

    const card = cardNamed('peliculas-tabla')
    expect(within(card).getByText('Descartado')).toBeInTheDocument()
    expect(within(card).getByText(/Tabla densa/)).toBeInTheDocument()
  })

  it('filters down to the discarded ones', async () => {
    renderGallery()
    await waitFor(() => expect(cardNamed('peliculas-tabla')).toBeTruthy())

    fireEvent.click(screen.getByRole('tab', { name: /Descartados/ }))

    expect(cards()).toHaveLength(1)
    expect(cardNamed('peliculas-tabla')).toBeTruthy()
  })

  it('shows an uncatalogued file rather than hiding it', async () => {
    renderGallery()

    await waitFor(() => expect(cardNamed('stray')).toBeTruthy())

    expect(within(cardNamed('stray')).getByText('Sin catalogar')).toBeInTheDocument()
  })

  it('says so when a filter matches nothing, instead of a blank page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: async () => [entry({ status: 'selected' })],
      } as Response),
    )
    render(<Prototypes />)

    await waitFor(() => expect(cards()).toHaveLength(1))

    fireEvent.click(screen.getByRole('tab', { name: /Descartados/ }))

    expect(screen.getByText('Ningún prototipo tiene ese estado todavía.')).toBeInTheDocument()
    expect(cards()).toHaveLength(0)
  })

  it('previews the design you click', async () => {
    renderGallery()
    await waitFor(() => expect(cardNamed('series-arbol')).toBeTruthy())

    fireEvent.click(cardNamed('series-arbol'))

    const frame = screen.getByTitle('series-01-arbol.html') as HTMLIFrameElement
    expect(frame.src).toContain('/prototypes/series-01-arbol.html')
  })

  it('counts every state on its own filter', async () => {
    renderGallery()
    await waitFor(() => expect(cardNamed('stray')).toBeTruthy())

    expect(screen.getByRole('tab', { name: /Todos/ })).toHaveTextContent('4')
    expect(screen.getByRole('tab', { name: /Elegidos/ })).toHaveTextContent('1')
    expect(screen.getByRole('tab', { name: /Descartados/ })).toHaveTextContent('1')
    expect(screen.getByRole('tab', { name: /En liza/ })).toHaveTextContent('1')
    expect(screen.getByRole('tab', { name: /Sin catalogar/ })).toHaveTextContent('1')
  })
})
