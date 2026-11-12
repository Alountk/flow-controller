/**
 * Shared authentication module.
 *
 * The browser authenticates with a login session: the backend sets an
 * HttpOnly cookie that scripts cannot read, so there is nothing to remember
 * here. What this module keeps is one flag: whether THIS page ever held a live
 * session, which is what tells a mid-session 401 (ask again) from the expected
 * 401 of the probes that mount before anyone has signed in.
 */

export interface AuthState {
  authenticated: boolean
  auth_required: boolean
  has_user: boolean
}

/** A login/register failure with the message the backend gave. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

let _hadSession = false

/** The page is signed in from now on; a later 401 means the session ended. */
export function markSessionActive() {
  _hadSession = true
}

export function resetSession() {
  _hadSession = false
}

export function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

/** Who am I? Always answers 200, so asking never spends the 401 budget. */
export async function fetchAuthState(): Promise<AuthState> {
  const res = await fetch('/api/auth/me')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const state = (await res.json()) as AuthState
  if (state.authenticated && state.has_user !== false) markSessionActive()
  return state
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(), ...headers },
      body: JSON.stringify(body),
    })
  } catch {
    throw new AuthError('No se pudo conectar con el servidor')
  }
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new AuthError(parsed.detail || `Error ${res.status}`)
  }
  markSessionActive()
}

export function login(username: string, password: string): Promise<void> {
  return post('/api/auth/login', { username, password })
}

/** Needs the current password too; the server keeps this browser signed in. */
export function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return post('/api/auth/password', {
    current_password: currentPassword,
    new_password: newPassword,
  })
}

/**
 * Create THE administrator. An install that still has its old API key must
 * present it once (`currentApiKey`): that is the proof it belongs to you.
 */
export function register(username: string, password: string, currentApiKey = ''): Promise<void> {
  return post(
    '/api/auth/register',
    { username, password },
    currentApiKey ? { 'X-Api-Key': currentApiKey } : {},
  )
}

export async function logout(): Promise<void> {
  resetSession()
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined)
}

/* ── Central 401 handling ──────────────────────────────────────────────────
 *
 * Every request goes through `apiFetch`, which reacts to a 401 on a page that
 * held a session by telling the app to show the login again.
 */

type UnauthorizedHandler = () => void

let _onUnauthorized: UnauthorizedHandler | null = null

/** The app registers how to react when the session is gone. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  _onUnauthorized = handler
}

/** Thrown on a 401, so callers can skip their own error UI. */
export class UnauthorizedError extends Error {
  constructor() {
    super('Sesión no válida')
    this.name = 'UnauthorizedError'
  }
}

/**
 * `fetch` plus one place that handles a lost session.
 *
 * A 401 on a page that never had a session is not a lost session — it is the
 * expected answer to the probes that fire before sign-in
 * (`useConfiguredServices` mounts with the shell). Signalling on those would
 * bounce the app back to the login right after a successful one.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) }
  const res = await fetch(input, { ...init, headers })

  if (res.status === 401) {
    const hadSession = _hadSession
    resetSession()
    if (hadSession) _onUnauthorized?.()
    throw new UnauthorizedError()
  }

  return res
}
