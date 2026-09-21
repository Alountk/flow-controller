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
