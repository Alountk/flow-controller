import { apiFetch } from './auth.ts'

export interface ServiceSetup {
  url?: string
  api_key?: string
  user?: string
  password?: string
}

export interface SetupStatus {
  needs_setup: boolean
  auth_required: boolean
}

/**
 * One wizard step's worth of configuration.
 *
 * `POST /api/setup` merges each present group onto the CURRENT settings, so a
 * body carrying a single group is partial-safe: everything the step did not
 * mention is left alone. That is why the wizard never uses `POST /api/settings`,
 * which merges `DEFAULTS ← body` and would reset every omitted group.
 */
export interface SetupStepBody {
  services?: Record<string, ServiceSetup>
  paths?: {
    download_amule?: string
    download_torrent?: string
    allowed_roots?: string[]
  }
  intervals?: Record<string, number>
  tracing?: { limit?: number }
  server?: { port?: number }
}

export interface SetupSaveResult {
  ok: boolean
  /** `false` when the config volume is read-only: applied in memory only. */
  persisted?: boolean
  restart_required: string[]
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await apiFetch('/api/setup')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as SetupStatus
}

/**
 * Save one wizard step.
 *
 * Needs the signed-in administrator: the account is created before the wizard,
 * so it answers 403 to anyone else.
 */
export async function saveSetupStep(body: SetupStepBody): Promise<SetupSaveResult> {
  const res = await apiFetch('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>
    throw new Error((parsed.detail as string) || `HTTP ${res.status}`)
  }
  return (await res.json()) as SetupSaveResult
}
