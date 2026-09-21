/**
 * Shared authentication module.
 *
 * The key is NOT served by the backend: /api/config is anonymous, and handing
 * the key out there let anyone reaching the port bootstrap to every stored
 * credential via /api/settings. Instead the user enters the key once and the
 * browser remembers it ("bring your own key").
 *
 * It is read synchronously at module load so no request can fire before the
 * key is in place.
 */

const STORAGE_KEY = 'flow-controller-api-key'

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    // Private mode or storage disabled: fall back to in-memory only.
    return ''
  }
}

let _apiKey = readStored()

export function setApiKey(key: string) {
  _apiKey = key
}

export function rememberApiKey(key: string) {
  setApiKey(key)
  try {
    localStorage.setItem(STORAGE_KEY, key)
  } catch {
    // Not fatal: the key still works for this session.
  }
}

export function forgetApiKey() {
  _apiKey = ''
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to clean up.
  }
}

/** Whether a key is available without asking the user. */
export function hasStoredApiKey(): boolean {
  return _apiKey !== ''
}

/** Validate a key against a protected endpoint. */
export async function verifyApiKey(key: string): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/check', { headers: { 'X-Api-Key': key } })
    return res.ok
  } catch {
    return false
  }
}

export function getApiKey(): string {
  return _apiKey
}

export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (_apiKey) h['X-Api-Key'] = _apiKey
  return h
}


/* ── Central 401 handling ──────────────────────────────────────────────────
 *
 * The key used to be validated exactly once, at boot. If it was later cleared,
 * rotated, or rejected, every call failed and the app never asked again — the
 * user just saw broken panels.
 *
 * Every request now goes through `apiFetch`, which reacts to a 401 by
 * forgetting the key and telling the app to ask for it again.
 */

type UnauthorizedHandler = () => void

let _onUnauthorized: UnauthorizedHandler | null = null

/** The app registers how to react when the backend rejects the key. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  _onUnauthorized = handler
}

/** Thrown when the backend rejects the key, so callers can skip their own UI. */
export class UnauthorizedError extends Error {
  constructor() {
    super('API key rechazada')
    this.name = 'UnauthorizedError'
  }
}

/**
 * `fetch` with the auth header, plus one place that handles a rejected key.
 *
 * On 401: forget the stored key and signal the app, so the key is asked for
 * again instead of silently failing every subsequent call.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) }
  const res = await fetch(input, { ...init, headers })

  if (res.status === 401) {
    forgetApiKey()
    _onUnauthorized?.()
    throw new UnauthorizedError()
  }

  return res
}
