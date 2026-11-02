import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '../../app/App.tsx'
import { setUnauthorizedHandler } from '../../shared/api/auth.ts'

/**
 * Carga por vista («carga-por-vista» S1/S2): each page travels in its own
 * chunk, so the first time one opens there is a moment with no page at all.
 * That moment has to say something — a blank screen with a working spinner
 * nowhere is indistinguishable from a broken app.
 *
 * The status message is also the guarded proxy for the cut itself: if the
 * pages went back to being imported eagerly, nothing would ever suspend and
 * this file would fail on the missing status, not on a bundle nobody looks at.
 */

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body } as Response)
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/config')) {
        return ok({ developer: false, auth_required: false, encryption_ok: true })
      }
      if (url.includes('/api/services')) return ok({ services: [], configured: ['radarr'] })
      if (url.includes('/api/status')) return ok({ radarr: 'online:ok' })
      if (url.includes('/api/trace')) {
        return ok({ traces: [], summary: {}, indexer: '', updated_at: 0 })
      }
      return ok({})
    }),
  )
}

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )
}

function at(path: string) {
  window.history.pushState(null, '', path)
}

beforeEach(() => {
  stubFetch()
  setUnauthorizedHandler(vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('carga por vista', () => {
  it('says it is loading while the page chunk travels, then shows the page (S2)', async () => {
    at('/dashboard')
    renderApp()
    // The shell first: nothing is lazy about the sidebar that navigates.
    await waitFor(() => expect(document.querySelector('.topbar-dot')).not.toBeNull())

    fireEvent.click(screen.getByRole('link', { name: /Media Mixer/ }))

    // A screen that was never opened brings its chunk with it: while it
    // travels the honest thing is to say so out loud.
    expect(await screen.findByRole('status')).toHaveTextContent('Cargando…')

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 5000 })
  })

  it('does not make the dashboard wait on a chunk it never needs (S1)', async () => {
    at('/dashboard')
    renderApp()

    // The dashboard is the default view and lives in the first chunk: making it
    // lazy would put a round-trip in front of the app's own landing page.
    expect(screen.queryByRole('status')).toBeNull()
    await waitFor(() => expect(document.querySelector('.topbar-dot')).not.toBeNull())
  })
})
