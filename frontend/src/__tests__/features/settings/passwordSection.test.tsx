import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PasswordSection } from '../../../features/settings/PasswordSection.tsx'

/** Changing the password is the one write here that locks the owner out if it
 *  goes wrong, so: the request carries both passwords, a rejected one is shown
 *  and nothing is cleared, and an install without an account shows no form. */

function mockFetch(hasUser: boolean, passwordReply: { ok: boolean; status?: number; detail?: string } = { ok: true }) {
  const fn = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/auth/password')) {
      return Promise.resolve({
        ok: passwordReply.ok,
        status: passwordReply.status ?? 200,
        json: async () => (passwordReply.ok ? { ok: true } : { detail: passwordReply.detail }),
      } as Response)
    }
    if (url.includes('/api/auth/me')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ authenticated: true, auth_required: hasUser, has_user: hasUser }),
      } as Response)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <PasswordSection />
    </QueryClientProvider>,
  )
}

function fill(current: string, next: string, repeat: string) {
  fireEvent.change(screen.getByLabelText('Contraseña actual'), { target: { value: current } })
  fireEvent.change(screen.getByLabelText('Nueva contraseña'), { target: { value: next } })
  fireEvent.change(screen.getByLabelText('Repite la nueva contraseña'), { target: { value: repeat } })
  fireEvent.click(screen.getByRole('button', { name: 'Cambiar contraseña' }))
}

afterEach(() => vi.unstubAllGlobals())

describe('PasswordSection', () => {
  it('shows nothing on an install without a login account', async () => {
    const fetchMock = mockFetch(false)
    renderSection()

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.queryByText('Cambiar contraseña')).toBeNull()
  })

  it('sends both passwords and confirms, clearing the fields', async () => {
    const fetchMock = mockFetch(true)
    renderSection()
    await screen.findByLabelText('Contraseña actual')

    fill('old password', 'a brand new pass', 'a brand new pass')

    expect(await screen.findByRole('status')).toHaveTextContent('Contraseña actualizada')
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/auth/password'))!
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      current_password: 'old password',
      new_password: 'a brand new pass',
    })
    expect(screen.getByLabelText('Contraseña actual')).toHaveValue('')
  })

  it('does not call the server when the two new passwords differ', async () => {
    const fetchMock = mockFetch(true)
    renderSection()
    await screen.findByLabelText('Contraseña actual')

    fill('old password', 'a brand new pass', 'something else!!')

    expect(await screen.findByRole('alert')).toHaveTextContent('no coinciden')
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/auth/password'))).toBe(false)
  })

  it('shows the server refusal and keeps what the user typed', async () => {
    mockFetch(true, { ok: false, status: 400, detail: 'La contraseña actual no es correcta' })
    renderSection()
    await screen.findByLabelText('Contraseña actual')

    fill('wrong one here', 'a brand new pass', 'a brand new pass')

    expect(await screen.findByRole('alert')).toHaveTextContent('La contraseña actual no es correcta')
    expect(screen.getByLabelText('Nueva contraseña')).toHaveValue('a brand new pass')
  })
})
