import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { ReleaseSearchModal } from '../components/ReleaseSearchModal'
import type { Release } from '../api/calendar'

/**
 * Wiring-level tests for the release filter bar.
 *
 * The pure logic is covered in releaseFilters.test.ts. What these guard is the
 * integration: that the modal actually feeds the FILTERED list to the counter,
 * the select-all control and the rendering. Getting that wrong is exactly how a
 * filter silently acts on rows the user cannot see.
 */

function makeRelease(overrides: Partial<Release> = {}): Release {
  return {
    guid: 'en-1',
    title: 'Everything Everywhere All at Once 2022 1080p BluRay',
    size: 10_000_000_000,
    quality: 'Bluray-1080p',
    indexer: 'aMuTorrent',
    indexerId: 1,
    indexerFlags: '',
    seeders: 10,
    leechers: 1,
    protocol: 'torrent',
    releaseGroup: '',
    languages: ['English'],
    ...overrides,
  }
}

const releases: Release[] = [
  makeRelease({ guid: 'en-1' }),
  makeRelease({
    guid: 'es-1',
    title: 'Todo a la vez en todas partes 2022 1080p',
    quality: 'WEBDL-1080p',
    languages: ['Spanish'],
  }),
]

const indexers = {
  indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }],
}

function mockFetch() {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/calendar/indexers')) {
      return Promise.resolve({ ok: true, json: async () => indexers } as Response)
    }
    if (url.includes('/api/calendar/releases')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ releases, detail: '2 releases encontrados' }),
      } as Response)
    }
    void init
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

async function openResults() {
  render(
    <ReleaseSearchModal
      item={{ type: 'movie', id: 411, title: 'Everything Everywhere All at Once', source: 'radarr' }}
      onClose={() => {}}
    />,
  )

  fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))

  await waitFor(() => expect(screen.getByPlaceholderText('Filtrar por título...')).toBeInTheDocument())
}

const filterInput = () => screen.getByPlaceholderText('Filtrar por título...')

/**
 * Scope queries to the releases region: the modal header also renders the item
 * title, so a document-wide text query would match the header too.
 */
const releasesRegion = () => document.querySelector('.calendar-releases') as HTMLElement

const releaseTitles = () =>
  [...document.querySelectorAll('.release-title')].map((el) => el.textContent ?? '')

describe('ReleaseSearchModal filter bar', () => {
  beforeEach(() => {
    mockFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows every release and the plain counter before filtering', async () => {
    await openResults()

    expect(screen.getByText('2 releases encontrados')).toBeInTheDocument()
    expect(releaseTitles()).toHaveLength(2)
    expect(within(releasesRegion()).getByText(/Todo a la vez/)).toBeInTheDocument()
  })

  it('shows "visible de total" once a filter narrows the list', async () => {
    await openResults()

    fireEvent.change(filterInput(), { target: { value: 'Todo' } })

    expect(screen.getByText('1 de 2 releases')).toBeInTheDocument()
  })

  it('hides the non-matching release', async () => {
    await openResults()

    fireEvent.change(filterInput(), { target: { value: 'Todo' } })

    expect(releaseTitles()).toEqual(['Todo a la vez en todas partes 2022 1080p'])
  })

  it('reports an empty state when nothing matches', async () => {
    await openResults()

    fireEvent.change(filterInput(), { target: { value: 'zzzzz' } })

    expect(screen.getByText('Ningún release coincide con los filtros')).toBeInTheDocument()
    expect(releaseTitles()).toHaveLength(0)
  })

  it('offers a chip per quality and per language present in the results', async () => {
    await openResults()

    expect(screen.getByRole('button', { name: 'Bluray-1080p' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'WEBDL-1080p' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spanish' })).toBeInTheDocument()
  })

  it('filters by a language chip', async () => {
    await openResults()

    fireEvent.click(screen.getByRole('button', { name: 'Spanish' }))

    expect(screen.getByText('1 de 2 releases')).toBeInTheDocument()
    expect(releaseTitles()).toEqual(['Todo a la vez en todas partes 2022 1080p'])
  })

  it('filters by a quality chip', async () => {
    await openResults()

    fireEvent.click(screen.getByRole('button', { name: 'Bluray-1080p' }))

    expect(releaseTitles()).toEqual(['Everything Everywhere All at Once 2022 1080p BluRay'])
  })

  it('filters by minimum seeders', async () => {
    await openResults()

    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '50' } })

    expect(screen.getByText('Ningún release coincide con los filtros')).toBeInTheDocument()
  })

  it('clears every filter at once', async () => {
    await openResults()

    fireEvent.change(filterInput(), { target: { value: 'Todo' } })
    expect(screen.getByText('1 de 2 releases')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Limpiar filtros/ }))

    expect(screen.getByText('2 releases encontrados')).toBeInTheDocument()
    expect((filterInput() as HTMLInputElement).value).toBe('')
  })

  it('select-all marks only the filtered releases', async () => {
    await openResults()

    fireEvent.change(filterInput(), { target: { value: 'Todo' } })

    const selectAll = screen.getByRole('checkbox', { name: /1 de 2 releases/ })
    fireEvent.click(selectAll)

    // The batch button counts only what was visible.
    expect(screen.getByRole('button', { name: /Descargar \(1\)/ })).toBeInTheDocument()
  })

  it('does not render empty indexer groups after filtering', async () => {
    await openResults()

    fireEvent.change(filterInput(), { target: { value: 'Todo' } })

    const groups = document.querySelectorAll('.calendar-indexer-group')
    expect(groups).toHaveLength(1)
    expect(within(groups[0] as HTMLElement).getByText(/Todo a la vez/)).toBeInTheDocument()
  })})
