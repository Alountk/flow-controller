import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Calendar } from '../components/Calendar'

/**
 * The "descarga pedida" mark on a calendar item.
 *
 * The calendar has its own stylesheet, so it uses `.calendar-grabbed` rather
 * than borrowing MissingContent's `.wanted-grabbed`. An unmarked item shows
 * NOTHING — not a dash and not an empty slot.
 */

// Noon UTC on 19 September 2026, so the local date is the same in any timezone.
const GRABBED_AT = Date.UTC(2026, 8, 19, 12, 0, 0) / 1000

function calendarItem(grabbedAt: number | null, destination: string | null = null) {
  return {
    type: 'movie',
    id: 855,
    title: 'Calendar Movie',
    date: '2026-09-19',
    year: 2026,
    has_file: false,
    remotePoster: '',
    series_title: null,
    season_number: null,
    episode_number: null,
    source: 'radarr',
    grabbed_at: grabbedAt,
    grabbed_destination: destination,
  }
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
}

function mockFetch(item: unknown) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    if (String(input).includes('/api/calendar?')) {
      return ok({ items: [item], start: '2026-09-01', end: '2026-10-01' })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderCalendar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Calendar />
    </QueryClientProvider>,
  )
}

/** The exact label the component must render, computed the same local way. */
function expectedLabel(ts: number): string {
  const d = new Date(ts * 1000)
  return `Pedida el ${d.getDate()} sep ${d.getFullYear()}`
}

describe('Calendar "descarga pedida" mark', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the mark and the date on a grabbed item', async () => {
    mockFetch(calendarItem(GRABBED_AT))
    renderCalendar()

    await screen.findByText('Calendar Movie')
    expect(await screen.findByText(expectedLabel(GRABBED_AT))).toBeInTheDocument()
    expect(document.querySelector('.calendar-card.status-grabbed')).not.toBeNull()
    expect(document.querySelector('.calendar-grabbed')).not.toBeNull()
  })

  it('shows where the download was sent on a grabbed item', async () => {
    mockFetch(calendarItem(GRABBED_AT, '/mnt/storage/movies/_manual'))
    renderCalendar()

    await screen.findByText('Calendar Movie')
    const mark = document.querySelector('.calendar-grabbed')

    expect(mark?.textContent).toContain(expectedLabel(GRABBED_AT))
    expect(mark?.textContent).toContain('→ _manual')
    expect(mark?.getAttribute('title')).toBe('/mnt/storage/movies/_manual')
  })

  it('shows nothing for an unmarked item', async () => {
    mockFetch(calendarItem(null))
    renderCalendar()

    await screen.findByText('Calendar Movie')
    await waitFor(() => expect(document.querySelectorAll('.calendar-card').length).toBe(1))

    expect(screen.queryByText(/Pedida el/)).not.toBeInTheDocument()
    expect(document.querySelectorAll('.calendar-grabbed')).toHaveLength(0)
    expect(document.querySelector('.calendar-card.status-grabbed')).toBeNull()
  })
})
