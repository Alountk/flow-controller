import { apiFetch } from './auth.ts'
import type { MixerLanguageCheck } from '../types.ts'

/* ── Types ─────────────────────────────────────────────────────────────────── */

export interface VideoTrack {
  index: number
  /** Ordinal inside the file's video streams — the `-map v:N` value (L18). */
  track_index?: number
  codec: string
  width: number
  height: number
  fps: number
  bitrate: number
  selected: boolean
}

export interface AudioTrack {
  index: number
  /** Ordinal inside the file's audio streams — the `-map a:N` value (L18). */
  track_index?: number
  codec: string
  language: string
  channels: number
  bitrate: number
  default: boolean
}

/** S6: one subtitle stream as `/api/mixer/probe` parses it. */
export interface SubtitleTrack {
  index: number
  track_index: number
  codec: string
  language: string
  language_code: string
  title: string
  forced: boolean
  default: boolean
  kind: 'text' | 'bitmap' | 'unknown'
  extractable: boolean
}

/** S5/T4: one merged audio row — `{**track, file, language_code, track_index,
 *  selected}` — already in the ca→en→ru→cat order. */
export interface AudioOrderedTrack extends AudioTrack {
  file: 'a' | 'b'
  language_code: string
  track_index: number
  selected: boolean
}

/** S4/T3: the best video track across BOTH files (may name file B). */
export interface BestVideo {
  file: 'a' | 'b'
  path: string
  /** Ordinal inside that file's video streams (L18). */
  track_index: number
  codec: string
  width: number
  height: number
  fps: number
  bitrate: number
}

export interface ProbeFile {
  filename: string
  path: string
  format: string
  duration: number
  size_bytes: number
  video_tracks: VideoTrack[]
  audio_tracks: AudioTrack[]
  subtitle_tracks?: SubtitleTrack[]
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
    /** Machine blockers (fps_mismatch | duration_mismatch), T2. */
    reasons?: string[]
    warnings: CompatibilityWarning[]
  }
  /** T4: required-language availability over the A+B union. */
  language_check?: MixerLanguageCheck
  /** T4: merged audio in the S2 order, with the «4 automáticas» marked. */
  audio_ordered?: AudioOrderedTrack[]
  /** T3: best video across A and B — `null` when neither file has video. */
  best_video?: BestVideo | null
}

/** The 409 body `POST /api/mixer/mux` answers a blocked mix with. */
export interface MuxConflict {
  error: string
  reasons?: string[]
  missing?: string[]
  required?: string[]
  compatibility?: {
    ok: boolean
    reasons: string[]
    warnings: CompatibilityWarning[]
  }
}

/** `startMux` errors carry the structured 409 detail when there is one. */
export type MuxError = Error & { conflict?: MuxConflict }

export interface MuxResponse {
  ok: boolean
  task_id?: string
  detail: string
}

/** The `task["subtitles"]` entries `GET /api/mixer/tasks/:id` exposes (T5/T6). */
export type MixerSubtitleStatus =
  | 'pending'
  | 'extracted'
  | 'failed'
  | 'not_extractable'
  | 'missing'
  | 'skipped'
  | 'downloaded'

export interface TaskSubtitle {
  language_code: string
  language: string
  path: string | null
  track_index: number | null
  codec: string | null
  extractable: boolean
  status: MixerSubtitleStatus
  detail: string
  sidecar: string | null
}

export interface MuxTask {
  task_id: string
  status: string
  progress: number
  detail: string
  output_path: string | null
  created_at: number
  subtitles?: TaskSubtitle[]
}

export interface TasksResponse {
  tasks: MuxTask[]
}

/* ── API Functions ─────────────────────────────────────────────────────────── */

export async function probeFiles(pathA: string, pathB: string): Promise<ProbeResult> {
  const res = await apiFetch('/api/mixer/probe', {
    method: 'POST',
    body: JSON.stringify({ path_a: pathA, path_b: pathB }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return res.json() as Promise<ProbeResult>
}

/** L24/T10: a user-marked `und` audio track travelling with the mux. */
export interface MuxLanguageOverride {
  path: string
  track_index: number
  language: string
}

export async function startMux(
  videoSource: { path: string; track_index: number },
  audioSources: { path: string; track_index: number }[],
  outputPath?: string,
  languageOverrides: MuxLanguageOverride[] = [],
): Promise<MuxResponse> {
  const body: Record<string, unknown> = {
    video_source: videoSource,
    audio_sources: audioSources,
  }
  if (outputPath) body.output_path = outputPath
  // L24: omitted when empty so the wire keeps its old shape.
  if (languageOverrides.length > 0) body.language_overrides = languageOverrides

  const res = await apiFetch('/api/mixer/mux', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const resp = await res.json().catch(() => ({})) as Record<string, unknown>
    const detail = resp.detail
    if (detail && typeof detail === 'object') {
      // 409 gates (S3/S2): keep the structured detail so the UI can show the
      // returned `error` and flip the badge red instead of failing silently.
      const conflict = detail as MuxConflict
      const err = new Error(conflict.error || `HTTP ${res.status}`) as MuxError
      err.conflict = conflict
      throw err
    }
    const msg = (typeof detail === 'string' ? detail : null) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return res.json() as Promise<MuxResponse>
}

export async function listTasks(): Promise<TasksResponse> {
  const res = await apiFetch('/api/mixer/tasks', {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<TasksResponse>
}

export async function getTask(taskId: string): Promise<{ ok: boolean } & Partial<MuxTask>> {
  const res = await apiFetch(`/api/mixer/tasks/${encodeURIComponent(taskId)}`, {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<{ ok: boolean } & Partial<MuxTask>>
}

export async function cancelTask(taskId: string): Promise<{ ok: boolean; detail: string }> {
  const res = await apiFetch(`/api/mixer/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: 'POST',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg }
  }
  return res.json() as Promise<{ ok: boolean; detail: string }>
}

export async function pauseTask(taskId: string): Promise<{ ok: boolean; detail: string }> {
  const res = await apiFetch(`/api/mixer/tasks/${encodeURIComponent(taskId)}/pause`, {
    method: 'POST',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg }
  }
  return res.json() as Promise<{ ok: boolean; detail: string }>
}

export async function resumeTask(taskId: string): Promise<{ ok: boolean; detail: string }> {
  const res = await apiFetch(`/api/mixer/tasks/${encodeURIComponent(taskId)}/resume`, {
    method: 'POST',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg }
  }
  return res.json() as Promise<{ ok: boolean; detail: string }>
}

/** S6/T6: search OpenSubtitles for the entries extraction could not give.  *
 *  `languages` carries three-letter `language_code` values (literal subset
 *  filter server-side); each hit is downloaded into the output sidecar. */
export interface SubtitleSearchResult {
  language: string
  language_code: string
  status: MixerSubtitleStatus
  sidecar?: string
  detail?: string
}

export async function searchTaskSubtitles(
  taskId: string,
  languages?: string[],
): Promise<{ ok: boolean; results: SubtitleSearchResult[] }> {
  const res = await apiFetch(`/api/mixer/tasks/${encodeURIComponent(taskId)}/subtitles/search`, {
    method: 'POST',
    body: JSON.stringify(languages ? { languages } : {}),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const detail = body.detail
    const msg = (typeof detail === 'string' ? detail : null)
      || (detail && typeof detail === 'object' ? JSON.stringify(detail) : null)
      || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return res.json() as Promise<{ ok: boolean; results: SubtitleSearchResult[] }>
}

/** T11/S10: the movie `POST /api/mixer/alternatives/lookup` resolved —
 *  non-null only when Radarr already owns it (the T7 pattern). */
export interface AlternativeLookupMovie {
  id: number
  title: string
  year?: number | null
  source: string
}

/** `POST /api/mixer/alternatives/lookup {path}` — the title and the audio
 *  languages both come from the OTHER slot's file (L26/L28). */
export interface AlternativeLookupResponse {
  ok: boolean
  /** Title derived from the filename (L26: it comes from that file). */
  title: string
  movie: AlternativeLookupMovie | null
  /** Three-letter audio codes, normalized, in the S2 order, deduped. */
  audio_languages: string[]
}

/** `GET /api/mixer/alternatives/status` — where the alternative download
 *  stands: `ready` (Radarr owns the file), `downloading` (a queue row matches
 *  the title), `unknown` (neither). */
export interface AlternativeStatusResponse {
  state: 'ready' | 'downloading' | 'unknown'
  /** Downloads-row percent (0–100) or null when it cannot be known. */
  progress: number | null
  path: string | null
  allowed: boolean
}

export async function alternativeLookup(path: string): Promise<AlternativeLookupResponse> {
  const res = await apiFetch('/api/mixer/alternatives/lookup', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return res.json() as Promise<AlternativeLookupResponse>
}

export async function alternativeStatus(
  movieId: number,
  title: string,
): Promise<AlternativeStatusResponse> {
  const params = new URLSearchParams({ movie_id: String(movieId), title })
  const res = await apiFetch(`/api/mixer/alternatives/status?${params.toString()}`, {})
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return res.json() as Promise<AlternativeStatusResponse>
}
