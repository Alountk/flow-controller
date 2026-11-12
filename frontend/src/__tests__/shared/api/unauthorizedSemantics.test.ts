/**
 * What a 401 means, and what it does not.
 *
 * `apiFetch` has one reaction to it — tell the app to show the login — but
 * only one of the two cases deserves it:
 *
 *   - a page that HELD a session and now gets refused → the session ended.
 *     Ask again.
 *   - a page that never had one getting the expected 401 → nothing is wrong.
 *     The probes that mount with the shell (`useConfiguredServices`) do this
 *     before anyone has signed in.
 *
 * Collapsing the two is what made the dashboard render nothing after a correct
 * sign-in: those pre-auth rejections landed after `onAuthenticated` and knocked
 * the app back to the login.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, markSessionActive, resetSession, setUnauthorizedHandler } from '../../../shared/api/auth.ts'

function stubFetch(status: number) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status }))
}

afterEach(() => {
  resetSession()
  setUnauthorizedHandler(null)
  vi.restoreAllMocks()
})

describe('a 401 on a page that never signed in', () => {
  it('does not signal the app to show the login again', async () => {
    stubFetch(401)
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)

    await expect(apiFetch('/api/services')).rejects.toThrow()

    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})

describe('a 401 on a page that held a session', () => {
  it('signals the app', async () => {
    markSessionActive()
    stubFetch(401)
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)

    await expect(apiFetch('/api/services')).rejects.toThrow()

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('does not signal again until a new session starts', async () => {
    markSessionActive()
    stubFetch(401)
    setUnauthorizedHandler(vi.fn())
    await expect(apiFetch('/api/a')).rejects.toThrow() // this one signals

    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    await expect(apiFetch('/api/b')).rejects.toThrow()

    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})
