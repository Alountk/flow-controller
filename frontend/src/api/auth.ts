/**
 * Shared authentication module.
 *
 * The API key is fetched from the backend at runtime (GET /api/config)
 * rather than being baked in at build time via VITE_API_KEY.
 * This allows the key to be changed in Portainer without rebuilding.
 */

let _apiKey = ''

export function setApiKey(key: string) {
  _apiKey = key
}

export function getApiKey(): string {
  return _apiKey
}

export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (_apiKey) h['X-Api-Key'] = _apiKey
  return h
}
