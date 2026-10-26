import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReleaseSearchModal } from '../../../features/release-search/ReleaseSearchModal.tsx'
import { clearToasts, getToasts } from '../../../shared/utils/toast.ts'
import type { Release } from '../../../shared/api/releases.ts'

/**
 * Grab feedback (F-13): while the request is in flight the status says what
 * is happening and why it may take a minute (the ED2K resolve is throttled
 * server-side — measured at ~30-60 s), and the outcome arrives as a toast —
 * the surface that reaches an operator who already looked away.
 */

/** A direct-source release row (S5): never the arr era's fields. */
const release: Release = {
  guid: 'guid-1',
  title: 'Everything Everywhere All at Once 2022 1080p BluRay',
  size: 10_000_000_000,
  indexer: 'aMuTorrent',
  source: 'torznab',
  link: 'https://idx.test/download/guid-1.torrent',
  seeders: 10,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const START_GRAB = {
  ok: true,
  task_id: 'grab-1',
  status: 'running',
  detail: 'Descarga lanzada',
}

const settled = (body: Record<string, unknown>): Response =>
  ({ ok: true, json: async () => body } as Response)

/**
 * async-grab: the POST only starts the job (or gates, for the in-flight
 * test) and the status GET serves the settled payload — `ok`/`detail` byte
 * for byte the body the synchronous endpoint used to return.
 */
function stubFetch(grabStatus: () => Response | Promise<Response>, post?: () => Response | Promise<Response>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const ok = (body: unknown) => Promise.resolve({ ok: true, json: async () => body } as Response)
    if (url.includes('/api/calendar/indexers')) {
      return ok({ indexers: [{ id: 1, name: 'aMuTorrent', implementation: 'Torznab', enableSearch: true }] })
    }
    if (url.includes('/api/calendar/releases')) {
      return ok({ releases: [release], detail: '1 releases encontrados' })
    }
    if (url.includes('/api/settings')) {
      return ok({ paths: { path_4k: '/mnt/4k', path_3d: '/mnt/3d' } })
    }
    if (url.includes('/api/calendar/grab')) {
      if (init?.method === 'POST') {
        return Promise.resolve(post ? post() : ok(START_GRAB))
      }
      return Promise.resolve(grabStatus())
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReleaseSearchModal
        item={{ type: 'movie', id: 411, title: 'X', source: 'radarr' }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
}

async function openAndPress() {
  renderModal()
  fireEvent.click(await screen.findByRole('button', { name: /Buscar Releases/ }))
  await screen.findByPlaceholderText('Filtrar por título...')
  await waitFor(() =>
    expect(
      document.querySelector('.release-dest-btn:not(:disabled)'),
    ).not.toBeNull(),
  )
  fireEvent.click(document.querySelector('.release-dest-btn') as HTMLElement)
}

describe('grab feedback', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    clearToasts()
  })

  it('says what is happening while the grab is in flight', async () => {
    const gate = deferred<Response>()
    stubFetch(
      () => settled({ ok: true, id: 'grab-1', status: 'done', detail: 'Release encolado para descarga' }),
      () => gate.promise,
    )

    await openAndPress()

    // The status box exists the moment the press lands — not after the answer.
    await screen.findByText(/Enviando la descarga al servidor/)
    expect(screen.getByText(/puede tardar hasta un minuto/)).toBeInTheDocument()

    gate.resolve({ ok: true, json: async () => START_GRAB } as Response)
    await waitFor(() => expect(screen.getByText('Release encolado para descarga')).toBeInTheDocument())
  })

  it('toasts the backend detail on success', async () => {
    stubFetch(() =>
      settled({ ok: true, id: 'grab-1', status: 'done', detail: 'directa: el arr no la verá' }),
    )

    await openAndPress()

    await waitFor(() => expect(getToasts().map((t) => t.message)).toContain('directa: el arr no la verá'))
    expect(getToasts()[0].tone).toBe('ok')
  })

  it('toasts the reason on failure, next to the error step', async () => {
    stubFetch(() =>
      settled({ ok: false, id: 'grab-1', status: 'done', detail: 'No encontré «X» en el indexador de aMule' }),
    )

    await openAndPress()

    await waitFor(() => expect(getToasts().map((t) => t.message)).toContain('No encontré «X» en el indexador de aMule'))
    expect(getToasts()[0].tone).toBe('error')
    // The modal's own error contract still holds beside the toast.
    expect(screen.getByText(/Volver a los resultados/)).toBeInTheDocument()
  })
})
