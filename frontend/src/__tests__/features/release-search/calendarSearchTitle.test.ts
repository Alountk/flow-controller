import { describe, it, expect, vi, afterEach } from 'vitest'
import { startCalendarReleaseSearch } from '../../../shared/api/releases.ts'

/**
 * S5 (calendario-directo): the search now runs over OUR own sources (S1),
 * queried by the ITEM'S TITLE — so the POST body must carry it next to the
 * item's identity. Without it the backend refuses synchronously with
 * «Falta el título del ítem para buscar en nuestras fuentes» and no job
 * ever starts.
 */
describe('startCalendarReleaseSearch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs the item title in the body', async () => {
    const fn = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, task_id: 't-1', status: 'running' }),
      } as Response),
    )
    vi.stubGlobal('fetch', fn)

    await startCalendarReleaseSearch(
      'radarr',
      'movie',
      411,
      'Everything Everywhere All at Once',
    )

    expect(fn).toHaveBeenCalledTimes(1)
    const [input, init] = fn.mock.calls[0]
    expect(String(input)).toContain('/api/calendar/releases')
    expect(init?.method).toBe('POST')
    // Exact JSON: the query is the title, and nothing else rides the body.
    expect(JSON.parse(String(init?.body))).toEqual({
      source: 'radarr',
      type: 'movie',
      id: 411,
      title: 'Everything Everywhere All at Once',
    })
  })
})
