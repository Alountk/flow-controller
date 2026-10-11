import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { Peliculas } from '../../pages/Peliculas.tsx'
import { Series } from '../../pages/Series.tsx'

/**
 * The style-side deltas of stitch-delta (T5/T6), pinned as a CSS contract
 * plus the render hook the scoped rules key on:
 *
 * - T5: the Archivos table's name column (the path-bearing cell) speaks
 *   `--mono`; the size/date columns keep the normal font — they are read as
 *   quantities, not identifiers,
 * - T6: each screen scopes its own master-detail split through a class on
 *   its existing root (no wrapper element): Películas ≈ 60/40, Series ≈
 *   40/60, still `minmax(0, …)` so overflow contracts, and the ≤1280px
 *   stacking still collapses EVERY scoped rule to one column.
 */

const sectionsCss = readFileSync('src/pages/Sections.css', 'utf8')

/** Drop comments so commented-out CSS cannot satisfy the contract. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

const clean = stripComments(sectionsCss)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Read the brace-delimited body that starts at `open` (index of the brace). */
function braceBody(source: string, open: number): string {
  let depth = 1
  let i = open + 1
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return source.slice(open + 1, depth === 0 ? i - 1 : i)
}

interface MediaBlock {
  condition: string
  body: string
  start: number
  end: number
}

/** All @media blocks in source order, with balanced-brace bodies. */
const mediaBlocks: MediaBlock[] = (() => {
  const blocks: MediaBlock[] = []
  const re = /@media([^{]*)\{/g
  let match: RegExpExecArray | null
  while ((match = re.exec(clean)) !== null) {
    const open = re.lastIndex - 1
    const body = braceBody(clean, open)
    blocks.push({
      condition: match[1].trim(),
      body,
      start: match.index,
      end: open + 1 + body.length + 1,
    })
  }
  return blocks
})()

/** Body of the first top-level rule for `selector`, ignoring rules inside @media. */
function topLevelRuleBody(selector: string): string {
  const re = new RegExp(`(?:^|[\\s}])${escapeRegExp(selector)}\\s*\\{`, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(clean)) !== null) {
    const open = clean.indexOf('{', match.index)
    if (mediaBlocks.some((b) => open >= b.start && open < b.end)) continue
    return braceBody(clean, open)
  }
  return ''
}

function blockAt(maxWidth: number): MediaBlock | undefined {
  return mediaBlocks.find((b) => new RegExp(`max-width:\\s*${maxWidth}px`).test(b.condition))
}

/** The `grid-template-columns` value of a rule body, whitespace-normalized. */
function gridColumns(body: string): string {
  const match = /grid-template-columns:\s*([^;}]+)/.exec(body)
  return match ? match[1].replace(/\s+/g, ' ').trim() : ''
}

/** The fr weights of every `minmax(0, Nfr)` track — non-0 mins drop out. */
function frTracks(body: string): number[] {
  return [...gridColumns(body).matchAll(/minmax\(\s*0\s*,\s*([\d.]+)fr\s*\)/g)].map((m) => Number(m[1]))
}

describe('T5 · Archivos table paths wear --mono', () => {
  it('the path-bearing name cell renders in the mono token', () => {
    const body = topLevelRuleBody('.sec-files-table .sec-file-name')
    expect(body, '.sec-files-table .sec-file-name rule exists').not.toBe('')
    expect(body).toMatch(/font-family:\s*var\(--mono\)/)
  })

  it('the size/date cells keep the normal font', () => {
    const body = topLevelRuleBody('.sec-files-table td')
    expect(body, '.sec-files-table td rule exists').not.toBe('')
    expect(body).not.toMatch(/font-family:\s*var\(--mono\)/)
  })
})

describe('T6 · per-screen master-detail split', () => {
  it('Películas scopes the split to ≈60/40 with overflow-safe tracks', () => {
    const tracks = frTracks(topLevelRuleBody('.sec-peliculas .sec-split'))
    expect(tracks, '.sec-peliculas .sec-split has two minmax(0, …fr) tracks').toHaveLength(2)
    expect(tracks[0] / (tracks[0] + tracks[1])).toBeCloseTo(0.6, 5)
  })

  it('Series scopes the split to ≈40/60 with overflow-safe tracks', () => {
    const tracks = frTracks(topLevelRuleBody('.sec-series .sec-split'))
    expect(tracks, '.sec-series .sec-split has two minmax(0, …fr) tracks').toHaveLength(2)
    expect(tracks[0] / (tracks[0] + tracks[1])).toBeCloseTo(0.4, 5)
  })

  it('the ≤1280px block still collapses the shared AND the scoped splits to one column', () => {
    const block = blockAt(1280)
    expect(block, '@media (max-width: 1280px) block exists').toBeDefined()
    for (const selector of ['.sec-split', '.sec-peliculas .sec-split', '.sec-series .sec-split']) {
      const collapsed = new RegExp(
        `[^{}]*${escapeRegExp(selector)}[^{}]*\\{[^}]*grid-template-columns:\\s*minmax\\(0,\\s*1fr\\)`,
      ).test(block!.body)
      expect(collapsed, `${selector} collapses to one column at ≤1280px`).toBe(true)
    }
  })

  it('each screen’s root carries the scope class the rules key on', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const renderSection = (Component: ComponentType) =>
      render(
        <QueryClientProvider client={client}>
          <Component />
        </QueryClientProvider>,
      )

    window.location.hash = ''
    stubSectionsFetch()
    const peliculas = renderSection(Peliculas)
    await screen.findByText('Your Name.')
    expect(peliculas.container.querySelector('.section-shell.sec-peliculas')).not.toBeNull()
    peliculas.unmount()

    stubSectionsFetch()
    const series = renderSection(Series)
    await screen.findByText('Some Show')
    expect(series.container.querySelector('.section-shell.sec-series')).not.toBeNull()
  })
})

/* ── Fetch stub for the render assertion (same shape as the section tests) ─ */

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

const catalogMovie = {
  id: 411,
  title: 'Your Name.',
  year: 2016,
  remotePoster: '',
  has_file: true,
  path: '/peliculas/Your Name. (2016)',
  path_exists: true,
  monitored: true,
  quality: 'Bluray-2160p',
  grabbed_at: null,
  grabbed_destination: null,
}

const catalogSeries = {
  id: 3,
  title: 'Some Show',
  year: 2006,
  remotePoster: '',
  has_file: true,
  path: '/series/Some Show',
  path_exists: true,
  monitored: true,
  episode_count: 10,
  episode_file_count: 4,
  grabbed_at: null,
  grabbed_destination: null,
}

function stubSectionsFetch() {
  vi.unstubAllGlobals()
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/services')) {
      return ok({ services: [], configured: ['radarr', 'sonarr'] })
    }
    if (url.includes('/api/wanted/series/all')) {
      return ok({ items: [catalogSeries], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted/all')) {
      return ok({ items: [catalogMovie], total: 1, page: 1, page_size: 50 })
    }
    if (url.includes('/api/wanted?')) {
      return ok({ wanted: { radarr: { items: [], total: 0 }, sonarr: { items: [], total: 0 } }, updated_at: 0 })
    }
    void init
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
}

beforeEach(() => {
  window.location.hash = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
})
