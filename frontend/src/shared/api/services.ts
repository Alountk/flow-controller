import { apiFetch } from './auth.ts'

/** One row of `GET /api/services` — config PRESENCE, never a network probe
 *  (the endpoint's documented contract: «sin salir a la red»). The keys the
 *  backend lists go beyond `ServiceKey` (radarr/sonarr/amutorrent/qbit): `amule`
 *  (kind `amule`) and `prowlarr` (kind `prowlarr`) live here too, so `key` is
 *  a plain string on purpose — narrowing it would lie about the payload. */
export interface ServiceListing {
  key: string
  kind: string
  url: string
  configured: boolean
}

export interface ServicesListResponse {
  services: ServiceListing[]
  configured: string[]
}

/** `GET /api/services` — which services are configured, without probing them.
 *
 * Same endpoint `useConfiguredServices` reads (that hook inlines its fetch and
 * only keeps the `configured` keys; this returns the whole payload — rows with
 * their `url` — for «Fuentes integradas», config-1x1 T7/S5). */
export async function fetchServices(): Promise<ServicesListResponse> {
  const res = await apiFetch('/api/services')
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return (await res.json()) as ServicesListResponse
}

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

/** Values typed in the aMule (EC) card but not saved yet (config-1x1 S1).
 *
 * The backend mirrors `POST /api/services/test`: what is present overrides the
 * stored config FOR THIS CALL, and what is absent, empty or masked falls back
 * to the stored one. A masked secret (`****…`, what GET returns) is never sent
 * as a candidate — omitting it is what makes the stored value win. */
export interface AmuleEcCandidate {
  url?: string
  ec_port?: string | number
  ec_password?: string
}

export async function testAmuleEc(candidate?: AmuleEcCandidate): Promise<AmuleEcTestResult> {
  // Nothing typed → no body at all: the backend probes the stored config,
  // byte-identical to the body-less call.
  const hasCandidate = candidate !== undefined && Object.keys(candidate).length > 0
  const res = await apiFetch(
    '/api/amule/test',
    hasCandidate
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(candidate),
        }
      : { method: 'POST' },
  )
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return (await res.json()) as AmuleEcTestResult
}

/** `GET /api/amule/health` — watchdog snapshot (amule-watchdog S6).
 *  `state`/`detail` arrive in Spanish, `*_at` are unix seconds or null. */
export interface AmuleHealth {
  state:
    | 'sano'
    | 'sin-datos'
    | 'sin-configurar'
    | 'colgado'
    | 'reiniciando'
    | 'recuperado'
    | 'alerta'
  detail: string
  checked_at: number | null
  consecutive_failures: number
  restart_attempts: number
  last_restart_at: number | null
}

export async function getAmuleHealth(): Promise<AmuleHealth> {
  const res = await apiFetch('/api/amule/health')
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return (await res.json()) as AmuleHealth
}

/* ── aMule control actions (amule-control S3/S4/S5) ───────────────────── */

/** `GET /api/amule/servers` — one row per server; fields are PRESENT-OR-ABSENT,
 *  never assumed (`failed` truthy = the server reports a failure; absent = the
 *  payload says nothing about it). `address` is «ip:puerto». */
export interface AmuleServerRow {
  name: string
  address: string
  failed?: boolean
  ping?: number
  users?: number
  files?: number
  prio?: number
  static?: boolean
}

export interface AmuleServersResponse {
  ok: boolean
  servers: AmuleServerRow[]
  detail: string
}

/** Every action answers `{ok, detail}`; a 422 (missing/empty field) answers
 *  `{detail}` only. */
export interface AmuleActionResult {
  ok: boolean
  detail: string
}

export async function getAmuleServers(): Promise<AmuleServersResponse> {
  const res = await apiFetch('/api/amule/servers')
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  return (await res.json()) as AmuleServersResponse
}

/** The verdict lives in the body (indexers.ts mold): a 422 carries `{detail}`
 *  that must reach the user, so only a fetch that itself throws escapes. */
async function amuleAction(path: string, body: Record<string, unknown>): Promise<AmuleActionResult> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as Partial<AmuleActionResult> | null
  return {
    ok: res.ok && data?.ok === true,
    detail:
      typeof data?.detail === 'string' && data.detail !== '' ? data.detail : `HTTP ${res.status}`,
  }
}

/** `name` is optional in the contract: an empty one is omitted, not sent blank. */
export function addAmuleServer(address: string, name?: string): Promise<AmuleActionResult> {
  const body: Record<string, unknown> = { address }
  const trimmed = name?.trim()
  if (trimmed) body.name = trimmed
  return amuleAction('/api/amule/servers/add', body)
}

export function removeAmuleServer(address: string): Promise<AmuleActionResult> {
  return amuleAction('/api/amule/servers/remove', { address })
}

export function connectAmuleServer(address: string): Promise<AmuleActionResult> {
  return amuleAction('/api/amule/servers/connect', { address })
}

export function addAmuleLink(link: string): Promise<AmuleActionResult> {
  return amuleAction('/api/amule/links', { link })
}
