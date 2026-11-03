import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Settings } from '../../features/settings/Settings.tsx'

/**
 * S1 — «Estoy viendo campos que se sobreponen de inputs y labels».
 *
 * A row is a single `.settings-field`. One row used to nest a whole second row
 * («Umbral de calidad» wrapped «Ancho manual» inside itself), which gave the
 * General panel a hard 913 px content floor: the row could not shrink, so the
 * panel overflowed its container and the label/input pairs collided. jsdom
 * does not compute layout, so the enforceable part is the structure that forces
 * it — measured by hand against the real backend before the fix (945 px of
 * content in an 816 px panel at 1440 px viewport).
 */

const settings = {
  services: {
    radarr: { url: 'http://localhost:7878', api_key: 'k' },
    sonarr: { url: 'http://localhost:8989', api_key: 'k' },
    amutorrent: { url: 'http://localhost:4000', api_key: 'k', user: 'admin', password: 'p' },
    qbit: { url: 'http://localhost:8080', user: 'admin', password: 'p' },
    opensubtitles: { api_key: '' },
    amule: { url: 'http://192.168.1.10', ec_port: '4712', ec_password: '****abcd' },
  },
  security: { api_key: '', safe_mode: true },
  developer: false,
  paths: {
    download_amule: '/mnt/storage-6tb/shared-downloads/amule',
    download_torrent: '/mnt/storage/downloads/qbittorrent/completed',
    output_mixed: '/mnt/storage/mixed',
    allowed_roots: ['/mnt/storage', '/mnt/storage-6tb'],
  },
  intervals: { check: 15, max_retries: 3, retry_delay: 2, request_timeout: 5, import_timeout: 40 },
  tracing: { limit: 25 },
  retention: { amule_days: 7 },
  quality: { min_class: 'Bluray-1080p', min_width: 0 },
  server: { port: 8000 },
}

function renderSettings() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const answer = url.includes('/api/settings')
        ? settings
        : url.includes('/api/indexers')
          ? { indexers: [] }
          : url.includes('/api/logs')
            ? { logs: [] }
            : {}
      return Promise.resolve({ ok: true, status: 200, json: async () => answer } as Response)
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  )
}

describe('filas de Configuración → General (S1: ninguna se pisa)', () => {
  beforeEach(() => renderSettings())
  afterEach(() => vi.unstubAllGlobals())

  it('no row contains another row', async () => {
    const panel = (await screen.findByRole('heading', { name: 'General', level: 2 })).closest(
      '.settings-panel',
    ) as HTMLElement
    await screen.findByLabelText('Umbral de calidad')

    const nested = [...panel.querySelectorAll('.settings-field')].filter(
      (row) => row.querySelectorAll('.settings-field').length > 0,
    )

    expect(nested.map((row) => row.textContent?.slice(0, 40))).toEqual([])
  })

  it('the width override is its own row, next to the slider row', async () => {
    const slider = await screen.findByLabelText('Umbral de calidad')
    const width = screen.getByLabelText('Ancho manual (px)')

    expect(slider.closest('.settings-field')).not.toBe(width.closest('.settings-field'))
    expect(width.closest('.settings-field')?.querySelector('input')).toBe(width)
  })
})
