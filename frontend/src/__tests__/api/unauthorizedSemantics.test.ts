/**
 * What a 401 means, and what it does not.
 *
 * `apiFetch` had one answer for both of these: forget the key and tell the app
 * to ask again. But only one of them is a rejected key —
 *
 *   - a request that CARRIED a key the backend refused  → the key is wrong or
 *     rotated. Ask again.
 *   - a request that carried NO key and got the expected 401 → nothing is
 *     wrong. The probes that mount with the shell (`useConfiguredServices`,
 *     `useDownloads`) do this before any key exists.
 *
 * Collapsing the two is what made the dashboard render nothing after a correct
 * login: those pre-auth rejections landed after `onAuthenticated` and knocked
 * the app back to the key prompt. Two end-to-end specs failed at a 5 s DOM
 * timeout and no amount of testing the login flow alone could have shown why.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, rememberApiKey, forgetApiKey, setUnauthorizedHandler } from '../../api/auth'

function stubFetch(status: number) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status }))
}

afterEach(() => {
  forgetApiKey()
  setUnauthorizedHandler(null)
  vi.restoreAllMocks()
})

describe('a 401 with no key is not a rejected key', () => {
  it('does not signal the app to ask again', async () => {
    stubFetch(401)
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)

    await expect(apiFetch('/api/services')).rejects.toThrow()

    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})

describe('a 401 on a request that carried a key', () => {
  it('signals the app and forgets the key', async () => {
    rememberApiKey('rotated-away')
    stubFetch(401)
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)

    await expect(apiFetch('/api/services')).rejects.toThrow()

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('sends the key it holds, so "carried" means what it says', async () => {
    rememberApiKey('the-key')
    const fetchSpy = stubFetch(200)

    await apiFetch('/api/services')

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['X-Api-Key']).toBe('the-key')
  })
})

describe('a 401 with no key after one was forgotten', () => {
  it('still does not signal — there is nothing to reject', async () => {
    rememberApiKey('gone')
    stubFetch(401)
    setUnauthorizedHandler(vi.fn())
    await expect(apiFetch('/api/a')).rejects.toThrow() // this one signals and forgets

    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    await expect(apiFetch('/api/b')).rejects.toThrow()

    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})
