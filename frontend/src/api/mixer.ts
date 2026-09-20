import { authHeaders } from './auth'

/* ── Types ─────────────────────────────────────────────────────────────────── */

export interface VideoTrack {
  index: number
  codec: string
  width: number
  height: number
  fps: number
  bitrate: number
  selected: boolean
}

export interface AudioTrack {
  index: number
  codec: string
  language: string
  channels: number
  bitrate: number
  default: boolean
}

export interface ProbeFile {
  filename: string
  path: string
  format: string
  duration: number
  size_bytes: number
  video_tracks: VideoTrack[]
  audio_tracks: AudioTrack[]
}

export interface CompatibilityWarning {
  type: 'fps_mismatch' | 'resolution_mismatch' | 'duration_mismatch'
  message: string
  file_a_value: string | number
  file_b_value: string | number
}

export interface ProbeResult {
  file_a: ProbeFile
  file_b: ProbeFile
  compatibility: {
    ok: boolean
    warnings: CompatibilityWarning[]
  }
}

export interface MuxResponse {
  ok: boolean
  task_id?: string
  detail: string
}

export interface MuxTask {
  task_id: string
  status: string
  progress: number
  detail: string
  output_path: string | null
  created_at: number
}

export interface TasksResponse {
  tasks: MuxTask[]
}

/* ── API Functions ─────────────────────────────────────────────────────────── */

export async function probeFiles(pathA: string, pathB: string): Promise<ProbeResult> {
  const res = await fetch('/api/mixer/probe', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ path_a: pathA, path_b: pathB }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return res.json() as Promise<ProbeResult>
}

export async function startMux(
  videoSource: { path: string; track_index: number },
  audioSources: { path: string; track_index: number }[],
  outputPath?: string,
): Promise<MuxResponse> {
  const body: Record<string, unknown> = {
    video_source: videoSource,
    audio_sources: audioSources,
  }
  if (outputPath) body.output_path = outputPath

  const res = await fetch('/api/mixer/mux', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const resp = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof resp.detail === 'string' ? resp.detail : null) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return res.json() as Promise<MuxResponse>
}

export async function listTasks(): Promise<TasksResponse> {
  const res = await fetch('/api/mixer/tasks', { headers: authHeaders() })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<TasksResponse>
}

export async function getTask(taskId: string): Promise<{ ok: boolean } & Partial<MuxTask>> {
  const res = await fetch(`/api/mixer/tasks/${encodeURIComponent(taskId)}`, { headers: authHeaders() })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<{ ok: boolean } & Partial<MuxTask>>
}

export async function cancelTask(taskId: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`/api/mixer/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg }
  }
  return res.json() as Promise<{ ok: boolean; detail: string }>
}

export async function pauseTask(taskId: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`/api/mixer/tasks/${encodeURIComponent(taskId)}/pause`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg }
  }
  return res.json() as Promise<{ ok: boolean; detail: string }>
}

export async function resumeTask(taskId: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`/api/mixer/tasks/${encodeURIComponent(taskId)}/resume`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg }
  }
  return res.json() as Promise<{ ok: boolean; detail: string }>
}
