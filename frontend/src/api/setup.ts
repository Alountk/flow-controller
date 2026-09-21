import { apiFetch } from './auth'

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

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await apiFetch('/api/setup')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as SetupStatus
}

export async function runSetup(
  services: Record<string, ServiceSetup>,
  apiKey: string,
): Promise<{ ok: boolean; restart_required: string[] }> {
  const res = await apiFetch('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ services, api_key: apiKey }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    throw new Error((body.detail as string) || `HTTP ${res.status}`)
  }
  return (await res.json()) as { ok: boolean; restart_required: string[] }
}
