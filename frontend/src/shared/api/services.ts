import { apiFetch } from './auth.ts'

export interface ServiceTestResult {
  key: string
  kind: string
  /** The URL actually attempted, which is the point during a proxy migration. */
  url: string
  ok: boolean
  version?: string
  detail: string
  error_kind?: string
}

export interface ServicesTestResponse {
  results: ServiceTestResult[]
  ok: boolean
}

export async function testServiceConnections(): Promise<ServicesTestResponse> {
  const res = await apiFetch('/api/services/test', {})
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return (await res.json()) as ServicesTestResponse
}

/** A URL and credentials the user has typed but not saved yet. */
export interface ServiceCandidate {
  service: string
  url?: string
  api_key?: string
  user?: string
  password?: string
}

/**
 * Probe a candidate configuration before it is committed.
 *
 * The GET form above reads what is *already stored*, which cannot answer the
 * only question a wizard step asks: "is the URL I just typed right?".
 */
export async function probeService(candidate: ServiceCandidate): Promise<ServiceTestResult> {
  const res = await apiFetch('/api/services/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(candidate),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  const data = (await res.json()) as { results?: ServiceTestResult[]; detail?: string }
  const result = data.results?.[0]
  if (!result) {
    // The backend answers `{results: [], ok: false}` for an unknown service.
    return {
      key: candidate.service,
      kind: '',
      url: candidate.url ?? '',
      ok: false,
      detail: data.detail ?? 'sin respuesta',
      error_kind: 'unreachable',
    }
  }
  return result
}

/** `POST /api/amule/test` — the aMule EC handshake probe (config-submenu S2).
 *
 * Lives here beside `testServiceConnections`/`probeService` because it is the
 * same kind of thing: a read-only connection probe whose verdict is a short
 * human sentence. The backend always answers HTTP 200 with `{ok, detail}` —
 * the verdict lives in the body, never in the status — so a rejected answer
 * here really is a transport failure, not a refused connection. */
export interface AmuleEcTestResult {
  ok: boolean
  detail: string
}

export async function testAmuleEc(): Promise<AmuleEcTestResult> {
  const res = await apiFetch('/api/amule/test', { method: 'POST' })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return (await res.json()) as AmuleEcTestResult
}
