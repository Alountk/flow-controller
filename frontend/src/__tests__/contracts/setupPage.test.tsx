import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '../../app/App.tsx'
import { forgetApiKey, hasStoredApiKey, setUnauthorizedHandler } from '../../shared/api/auth.ts'
import type { ServiceTestResult } from '../../shared/api/services.ts'

/**
 * A fresh install must be configurable from the UI, step by step.
 *
 * The wizard is a single focus card: a counter with dots, one step at a
 * time, Atrás/Siguiente only — there is no step list to jump with. Each
 * step saves with its own `POST /api/setup` body, and candidate URLs are
 * probed before they are committed. Entering requires at least one of
 * Radarr or Sonarr; aMuTorrent is optional. The two original gate tests are
 * the safety net and did not change.
 */

interface MockOpts {
  needsSetup: boolean
  authRequired: boolean
  /** What `POST /api/services/test` answers with for the candidate probe. */
  probe?: ServiceTestResult
  /** `persisted: false` — the config volume is read-only. */
  persisted?: boolean
}

function mockFetch(opts: MockOpts) {
  let needsSetup = opts.needsSetup
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const json = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)

    if (url.includes('/api/setup')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          services?: Record<string, { url?: string; api_key?: string }>
          api_key?: string
        }
        // Mirrors the backend: `needs_setup` flips as soon as one service has
        // a URL and a key. The wizard must not invalidate the ['setup'] query
        // itself — that would unmount it mid-run.
        const configured = Object.values(body.services ?? {}).some((s) => s.url && s.api_key)
        if (configured || body.api_key) needsSetup = false
        return json({ ok: true, persisted: opts.persisted ?? true, restart_required: [] })
      }
      return json({ needs_setup: needsSetup, auth_required: opts.authRequired })
    }
    if (url.includes('/api/services/test')) {
      const result = opts.probe
      return json({ results: result ? [result] : [], ok: Boolean(result?.ok) })
    }
    if (url.includes('/api/config')) {
      return json({ developer: false, auth_required: opts.authRequired, encryption_ok: true })
    }
    if (url.includes('/api/auth/check')) return json({ ok: true })
    if (url.includes('/api/services')) return json({ services: [], configured: [] })
    if (url.includes('/api/status')) return json({ flow: 'unconfigured', checking: false, updated_at: 0 })
    if (url.includes('/api/trace')) return json({ items: [], summary: {} })
    if (url.includes('/api/actions')) return json({ actions: {} })
    if (url.includes('/api/downloads')) return json({ downloads: [], errors: [] })
    return json({})
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )
}

/** Every `POST /api/setup` body, in order. */
function setupPosts(fn: ReturnType<typeof mockFetch>) {
  return fn.mock.calls
    .filter(([url, init]) => String(url).includes('/api/setup') && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
}

async function start() {
  renderApp()
  await screen.findByRole('heading', { name: 'Bienvenido a Flow Controller' })
}

/** Advance with `Siguiente`, waiting for each heading in turn. */
async function advanceThrough(...headings: string[]) {
  for (const name of headings) {
    fireEvent.click(await screen.findByRole('button', { name: 'Siguiente' }))
    await screen.findByRole('heading', { name })
  }
}

/** Class list of each progress dot, in step order. */
function dotClasses() {
  return [...document.querySelectorAll('.setup-dot')].map((el) => el.className)
}

const PROBE_CASES: { name: string; result: ServiceTestResult; expected: string }[] = [
  {
    name: 'a service that answers',
    result: {
      key: 'radarr',
      kind: 'arr',
      url: 'http://candidate:7878',
      ok: true,
      version: '6.4.4',
      detail: 'Conectado (6.4.4)',
    },
    expected: '✓ Conectado (6.4.4)',
  },
  {
    name: 'a rejected API key',
    result: {
      key: 'radarr',
      kind: 'arr',
      url: 'http://candidate:7878',
      ok: false,
      error_kind: 'auth',
      detail: 'radarr: API key rechazada (HTTP 401)',
    },
    expected: '✗ API key rechazada (HTTP 401)',
  },
  {
    name: 'a service that timed out',
    result: {
      key: 'radarr',
      kind: 'arr',
      url: 'http://candidate:7878',
      ok: false,
      error_kind: 'timeout',
      detail: 'radarr: no respondió a tiempo',
    },
    expected: '⏱ no respondió a tiempo',
  },
  {
    name: 'an unreachable service',
    result: {
      key: 'radarr',
      kind: 'arr',
      url: 'http://candidate:7878',
      ok: false,
      error_kind: 'unreachable',
      detail: 'radarr: no se pudo conectar (ClientError)',
    },
    expected: '⚠ no se pudo conectar',
  },
]

describe('first-run setup wizard', () => {
  beforeEach(() => {
    forgetApiKey()
    window.location.hash = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setUnauthorizedHandler(null)
    forgetApiKey()
  })

  // ── The gate: these two must survive every redesign of the page ──────────

  it('replaces the key prompt on an install with nothing configured', async () => {
    mockFetch({ needsSetup: true, authRequired: false })
    renderApp()

    expect(await screen.findByText(/Bienvenido a Flow Controller/)).toBeInTheDocument()
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
  })

  it('does not appear when the install is already configured', async () => {
    mockFetch({ needsSetup: false, authRequired: true })
    renderApp()

    // With a key configured and none stored, the gate is what shows.
    await waitFor(() => expect(screen.getByLabelText('API key')).toBeInTheDocument())
    expect(screen.queryByText(/Bienvenido/)).not.toBeInTheDocument()
  })

  // ── The step-8 rule: at least one of Radarr/Sonarr, aMuTorrent optional ──

  it('disables Entrar until Radarr or Sonarr is configured', async () => {
    mockFetch({ needsSetup: true, authRequired: false })
    await start()

    // Walk all eight steps without configuring any service.
    fireEvent.click(screen.getByRole('button', { name: 'Empezar' }))
    await advanceThrough(
      'Sonarr',
      'aMuTorrent (opcional)',
      'Rutas',
      'Ajustes',
      'Proteger la app',
      'Revisar y entrar',
    )

    expect(screen.getByRole('button', { name: 'Entrar' })).toBeDisabled()
    expect(screen.getByText('Configura Radarr o Sonarr para continuar')).toBeInTheDocument()
    // Nothing failed: the optional service simply reads as not configured.
    expect(screen.getByText('Sin configurar (opcional)')).toBeInTheDocument()
    expect(screen.getAllByText('Sin configurar')).toHaveLength(2)
  })

  it('enables Entrar when only Radarr is configured', async () => {
    mockFetch({ needsSetup: true, authRequired: false })
    await start()

    fireEvent.click(screen.getByRole('button', { name: 'Empezar' }))
    await screen.findByRole('heading', { name: 'Radarr' })
    fireEvent.change(screen.getByLabelText('URL de Radarr'), {
      target: { value: 'http://r:7878' },
    })
    fireEvent.change(screen.getByLabelText('API Key de Radarr'), { target: { value: 'r-key' } })

    // Sonarr and aMuTorrent stay empty — one of the two required services
    // is enough.
    await advanceThrough(
      'Sonarr',
      'aMuTorrent (opcional)',
      'Rutas',
      'Ajustes',
      'Proteger la app',
      'Revisar y entrar',
    )

    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled()
    expect(
      screen.queryByText('Configura Radarr o Sonarr para continuar'),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Sin configurar (opcional)')).toBeInTheDocument()
  })

  // ── Rewritten: the single-screen layout they pinned is gone ──────────────

  it('shows each service on its own step', async () => {
    mockFetch({ needsSetup: true, authRequired: false })
    await start()

    // Nothing of the services is on the welcome step.
    expect(screen.queryByLabelText('URL de Radarr')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('URL de Sonarr')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Usuario de aMuTorrent')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Empezar' }))
    expect(await screen.findByLabelText('URL de Radarr')).toBeInTheDocument()
    expect(screen.getByLabelText('API Key de Radarr')).toBeInTheDocument()
    expect(screen.queryByLabelText('URL de Sonarr')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Usuario de aMuTorrent')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(await screen.findByLabelText('URL de Sonarr')).toBeInTheDocument()
    expect(screen.getByLabelText('API Key de Sonarr')).toBeInTheDocument()
    expect(screen.queryByLabelText('URL de Radarr')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Usuario de aMuTorrent')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(await screen.findByLabelText('URL de aMuTorrent')).toBeInTheDocument()
    expect(screen.getByLabelText('API Key de aMuTorrent')).toBeInTheDocument()
    expect(screen.getByLabelText('Usuario de aMuTorrent')).toBeInTheDocument()
    expect(screen.getByLabelText('Contraseña de aMuTorrent')).toBeInTheDocument()
    expect(screen.queryByLabelText('URL de Radarr')).not.toBeInTheDocument()
  })

  it('lets the user leave the app unprotected', async () => {
    mockFetch({ needsSetup: true, authRequired: false })
    await start()

    // The key field lives on its own step, not on the first paint.
    expect(screen.queryByLabelText('API key de la app')).not.toBeInTheDocument()

    // One service must be configured: without it `needs_setup` stays true and
    // the wizard would come back after `Entrar`.
    fireEvent.click(screen.getByRole('button', { name: 'Empezar' }))
    await screen.findByRole('heading', { name: 'Radarr' })
    fireEvent.change(screen.getByLabelText('URL de Radarr'), { target: { value: 'http://r:7878' } })
    fireEvent.change(screen.getByLabelText('API Key de Radarr'), { target: { value: 'r-key' } })
    await advanceThrough('Sonarr', 'aMuTorrent (opcional)', 'Rutas', 'Ajustes', 'Proteger la app')

    expect(await screen.findByLabelText('API key de la app')).toBeInTheDocument()
    expect(screen.getByText(/Sin clave, cualquiera que alcance el puerto/)).toBeInTheDocument()
    expect(screen.getByText('Último paso que guarda')).toBeInTheDocument()
    expect(hasStoredApiKey()).toBe(false)

    // Left empty, the wizard still lets the user finish.
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    await screen.findByRole('heading', { name: 'Revisar y entrar' })
    expect(hasStoredApiKey()).toBe(false)
    expect(screen.getByText('Sin clave de la app')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }))
    await screen.findByText('Resumen del sistema')
    expect(screen.queryByRole('heading', { name: 'Revisar y entrar' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
  })

  it('saves each step on its own and remembers the key at step 7', async () => {
    const fn = mockFetch({ needsSetup: true, authRequired: false })
    await start()

    fireEvent.click(screen.getByRole('button', { name: 'Empezar' }))
    await screen.findByRole('heading', { name: 'Radarr' })
    fireEvent.change(screen.getByLabelText('URL de Radarr'), { target: { value: 'http://r:7878' } })
    fireEvent.change(screen.getByLabelText('API Key de Radarr'), { target: { value: 'r-key' } })

    await advanceThrough('Sonarr', 'aMuTorrent (opcional)', 'Rutas', 'Ajustes', 'Proteger la app')
    expect(hasStoredApiKey()).toBe(false)

    fireEvent.change(screen.getByLabelText('API key de la app'), { target: { value: 'app-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    await screen.findByRole('heading', { name: 'Revisar y entrar' })

    // Remembered the moment step 7 saves — later requests need X-Api-Key.
    expect(hasStoredApiKey()).toBe(true)

    const bodies = setupPosts(fn)
    expect(bodies).toHaveLength(6)
    expect(bodies[0]).toEqual({ services: { radarr: { url: 'http://r:7878', api_key: 'r-key' } } })
    expect(bodies[1]).toEqual({ services: { sonarr: { url: '', api_key: '' } } })
    expect(bodies[2]).toEqual({
      services: { amutorrent: { url: '', api_key: '', user: '', password: '' } },
    })
    expect(Object.keys(bodies[3])).toEqual(['paths'])
    expect(Object.keys(bodies[4])).toEqual(['intervals', 'tracing', 'server'])
    expect(bodies[5]).toEqual({ api_key: 'app-key' })

    // Step 8 writes nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }))
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Revisar y entrar' })).not.toBeInTheDocument(),
    )
    expect(setupPosts(fn)).toHaveLength(6)
  })

  // ── Rewritten: navigation, per-step saves, the candidate probe ───────────

  it('walks the eight steps with Atrás and Siguiente, with no step list to jump', async () => {
    const fn = mockFetch({ needsSetup: true, authRequired: false })
    await start()

    // Counter and dots open on step 1 of 8: current emphasised, rest pending.
    expect(screen.getByText('1 de 8')).toBeInTheDocument()
    expect(dotClasses()[0]).toContain('is-now')
    expect(dotClasses().slice(1).every((c) => c === 'setup-dot')).toBe(true)

    // No sidebar and no step list: steps past the current one are not
    // reachable, so there is nothing to jump with.
    expect(screen.queryByLabelText('Pasos del asistente')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Rutas/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Atrás' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Empezar' }))
    await screen.findByRole('heading', { name: 'Radarr' })
    expect(screen.getByText('2 de 8')).toBeInTheDocument()
    expect(dotClasses()[0]).toContain('is-done')
    expect(dotClasses()[1]).toContain('is-now')

    fireEvent.change(screen.getByLabelText('URL de Radarr'), { target: { value: 'http://r:7878' } })
    fireEvent.change(screen.getByLabelText('API Key de Radarr'), { target: { value: 'r-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    await screen.findByRole('heading', { name: 'Sonarr' })
    expect(screen.getByText('3 de 8')).toBeInTheDocument()

    // Atrás walks back one step, allowed at any time.
    fireEvent.click(screen.getByRole('button', { name: 'Atrás' }))
    await screen.findByRole('heading', { name: 'Radarr' })
    expect(screen.getByText('2 de 8')).toBeInTheDocument()

    // Forward again: Siguiente is the only way ahead.
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    await advanceThrough(
      'aMuTorrent (opcional)',
      'Rutas',
      'Ajustes',
      'Proteger la app',
      'Revisar y entrar',
    )

    expect(screen.getByText('8 de 8')).toBeInTheDocument()
    const dots = dotClasses()
    expect(dots.slice(0, 7).every((c) => c.includes('is-done'))).toBe(true)
    expect(dots[7]).toContain('is-now')
    expect(screen.queryByLabelText('Pasos del asistente')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Rutas/ })).not.toBeInTheDocument()

    // Step 8 is reachable but never writable: no field of its own, no POST.
    const postsBefore = setupPosts(fn).length
    expect(document.querySelector('input')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }))
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Revisar y entrar' })).not.toBeInTheDocument(),
    )
    expect(setupPosts(fn)).toHaveLength(postsBefore)
  })

  it('posts only the paths group when advancing past Rutas', async () => {
    const fn = mockFetch({ needsSetup: true, authRequired: false })
    await start()

    fireEvent.click(screen.getByRole('button', { name: 'Empezar' }))
    await screen.findByRole('heading', { name: 'Radarr' })
    await advanceThrough('Sonarr', 'aMuTorrent (opcional)', 'Rutas')

    fireEvent.change(screen.getByLabelText('Carpeta descargas aMuTorrent'), {
      target: { value: '/data/amule' },
    })
    fireEvent.change(screen.getByLabelText('Carpeta descargas Torrent'), {
      target: { value: '/data/torrent' },
    })
    fireEvent.change(screen.getByLabelText('Raíces permitidas (separadas por coma)'), {
      target: { value: '/mnt/a, /mnt/b' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    await screen.findByRole('heading', { name: 'Ajustes' })

    const bodies = setupPosts(fn)
    const pathsBody = bodies[bodies.length - 1]
    expect(pathsBody).toEqual({
      paths: {
        download_amule: '/data/amule',
        download_torrent: '/data/torrent',
        allowed_roots: ['/mnt/a', '/mnt/b'],
      },
    })
    // Only the step's own group — sending more would be fine, sending less is
    // fine too, but this body must not drag services or the app key along.
    expect(Object.keys(pathsBody)).toEqual(['paths'])
  })

  it.each(PROBE_CASES)(
    'probes the typed URL and renders $name as "$expected"',
    async ({ result, expected }) => {
      const fn = mockFetch({ needsSetup: true, authRequired: false, probe: result })
      await start()

      fireEvent.click(screen.getByRole('button', { name: 'Empezar' }))
      await screen.findByRole('heading', { name: 'Radarr' })
      expect(screen.getByText('Sin comprobar')).toBeInTheDocument()

      fireEvent.change(screen.getByLabelText('URL de Radarr'), {
        target: { value: 'http://candidate:7878' },
      })
      fireEvent.change(screen.getByLabelText('API Key de Radarr'), { target: { value: 'typed-key' } })
      fireEvent.click(screen.getByRole('button', { name: 'Probar conexión' }))
      expect(await screen.findByText(expected)).toBeInTheDocument()

      const probeCall = fn.mock.calls.find(
        ([url, init]) => String(url).includes('/api/services/test') && init?.method === 'POST',
      )
      expect(JSON.parse(String(probeCall?.[1]?.body))).toMatchObject({
        service: 'radarr',
        url: 'http://candidate:7878',
        api_key: 'typed-key',
      })

      // The probe is advisory: a failure never blocks the step.
      expect(screen.getByRole('button', { name: 'Siguiente' })).toBeEnabled()
    },
  )

  it('keeps a failed probe visible instead of blocking the wizard', async () => {
    mockFetch({
      needsSetup: true,
      authRequired: false,
      probe: {
        key: 'radarr',
        kind: 'arr',
        url: 'http://r:7878',
        ok: false,
        error_kind: 'auth',
        detail: 'radarr: API key rechazada (HTTP 401)',
      },
    })
    await start()

    fireEvent.click(screen.getByRole('button', { name: 'Empezar' }))
    await screen.findByRole('heading', { name: 'Radarr' })
    fireEvent.change(screen.getByLabelText('URL de Radarr'), { target: { value: 'http://r:7878' } })
    fireEvent.change(screen.getByLabelText('API Key de Radarr'), { target: { value: 'r-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Probar conexión' }))
    await screen.findByText('✗ API key rechazada (HTTP 401)')

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    await screen.findByRole('heading', { name: 'Sonarr' })

    // Completed: the dots move on, but the failed probe stays the truth.
    expect(dotClasses()[0]).toContain('is-done')

    await advanceThrough(
      'aMuTorrent (opcional)',
      'Rutas',
      'Ajustes',
      'Proteger la app',
      'Revisar y entrar',
    )

    // The review step lists every service's last result.
    expect(screen.getByText('✗ API key rechazada (HTTP 401)')).toBeInTheDocument()
    expect(screen.getAllByText('Sin comprobar')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled()
  })

  it('warns instead of claiming a save when the config volume is read-only', async () => {
    mockFetch({ needsSetup: true, authRequired: false, persisted: false })
    await start()

    fireEvent.click(screen.getByRole('button', { name: 'Empezar' }))
    await screen.findByRole('heading', { name: 'Radarr' })
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/solo lectura/)
  })
})
