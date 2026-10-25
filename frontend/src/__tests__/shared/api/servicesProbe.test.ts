import { describe, it, expect, vi, afterEach } from 'vitest'
import { probeService } from '../../../shared/api/services.ts'

/**
 * Probe contract for the qbit candidate (qbit-nativo T3/S3): `probeService`
 * must send the new service in the SAME shape it already sends for
 * `amutorrent` — `{service, url, user, password}`, credentials included and
 * no `api_key` (qbit has none). The backend `POST /api/services/test` probe
 * for `service=qbit` reads exactly these fields.
 */

function mockFetchCapture() {
  const bodies: unknown[] = []
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void input
    bodies.push(JSON.parse(String(init?.body)))
    return Promise.resolve({
      ok: true,
      json: async () => ({
        results: [
          {
            key: 'qbit',
            kind: 'qbittorrent',
            url: 'http://111.111.111.111:8080',
            ok: true,
            detail: 'Conectado (v5.1.4)',
          },
        ],
        ok: true,
      }),
    } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return bodies
}

describe('probeService qbit candidate', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the qbit probe in the same shape as amutorrent (user/password fields)', async () => {
    const bodies = mockFetchCapture()

    const result = await probeService({
      service: 'qbit',
      url: 'http://111.111.111.111:8080',
      user: 'chan',
      password: 'pw',
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual({
      service: 'qbit',
      url: 'http://111.111.111.111:8080',
      user: 'chan',
      password: 'pw',
    })
    expect(result.key).toBe('qbit')
    expect(result.ok).toBe(true)
    expect(result.detail).toBe('Conectado (v5.1.4)')
  })
})
