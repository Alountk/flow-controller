import { apiFetch } from './auth.ts'

/* ── Types ─────────────────────────────────────────────────────────────────── */

// Field names pin `parse_probe_data` (backend/media_mixer.py) exactly — what
// the parser emits, nothing invented.

export interface ProbeVideoTrack {
  index: number
  /** Ordinal within the file's video streams — the `-map v:N` value. */
  track_index: number
  codec: string
  width: number
  height: number
  fps: number
  bitrate: number
  /** ffprobe `profile` verbatim ("unknown" when the stream reports none). */
  profile: string
  /** ffprobe level_idc (40 = 4.0); 0 = unknown — ffprobe's -999 never leaks. */
  level: number
  /** Raw range evidence verbatim: HDR10/HLG labels derive in the UI, not here. */
  color_transfer: string
  color_primaries: string
  pix_fmt: string
  selected: boolean
}

export interface ProbeAudioTrack {
  index: number
  /** Ordinal within the file's audio streams — the `-map a:N` value. */
  track_index: number
  codec: string
  language: string
  channels: number
  bitrate: number
  default: boolean
}

export interface ProbeSubtitleTrack {
  index: number
  /** Ordinal within the file's subtitle streams — the `-map s:N` value. */
  track_index: number
  codec: string
  language: string
  language_code: string
  title: string
  forced: boolean
  default: boolean
  kind: 'text' | 'bitmap' | 'unknown'
  /** Only text can become .srt without OCR. */
  extractable: boolean
}

export interface ProbeFile {
  filename: string
  path: string
  format: string
  duration: number
  size_bytes: number
  video_tracks: ProbeVideoTrack[]
  audio_tracks: ProbeAudioTrack[]
  subtitle_tracks: ProbeSubtitleTrack[]
}

/** What `POST /api/mixer/probe-file` resolves to — switch on `ok`. */
export type ProbeFileResult =
  | { ok: true; probe: ProbeFile }
  | { ok: false; detail: string }

/**
 * Single-file probe: POST a server path, get its `parse_probe_data` payload.
 *
 * Never rejects: a transport failure resolves to the same `{ok:false, detail}`
 * answer an HTTP refusal gives, so a dead backend can never leave the panel
 * hanging on a pending promise.
 */
export async function probeFile(path: string): Promise<ProbeFileResult> {
  let res: Response
  try {
    res = await apiFetch('/api/mixer/probe-file', {
      method: 'POST',
      body: JSON.stringify({ path }),
    })
  } catch (err) {
    return { ok: false, detail: `Error de conexión: ${err}` }
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    return { ok: false, detail: msg }
  }
  return { ok: true, probe: await res.json() as ProbeFile }
}

/**
 * Persisted specs for the visible files: POST the paths, get a map where a
 * `null` value means «not analyzed yet or stale» — the caller then asks
 * `probeFile` for that one file. Never runs ffprobe.
 *
 * Never rejects: a transport failure resolves to an empty map, which reads
 * as «nothing analyzed» and simply shows no quality chip.
 */
export async function probeCached(paths: string[]): Promise<Record<string, ProbeFile | null>> {
  if (paths.length === 0) return {}
  try {
    const res = await apiFetch('/api/mixer/probe-cached', {
      method: 'POST',
      body: JSON.stringify({ paths }),
    })
    if (!res.ok) return {}
    return await res.json() as Record<string, ProbeFile | null>
  } catch {
    return {}
  }
}

/** The measured height of a probe's chosen video track (0 when it says none). */
export function probeHeight(probe: ProbeFile): number {
  const track = probe.video_tracks.find((t) => t.selected) ?? probe.video_tracks[0]
  return track?.height ?? 0
}

/** Job status of the library sweep («Analizar biblioteca»). */
export interface ProbeLibraryStatus {
  running: boolean
  total: number
  analyzed: number
  skipped: number
  failed: number
  started_at: number
  finished_at: number
}

/** Start the sweep; a refused start carries the server's own reason. */
export async function probeLibraryStart(): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const res = await apiFetch('/api/mixer/probe-library', { method: 'POST' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>
      return {
        ok: false,
        detail: (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`,
      }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: `Error de conexión: ${err}` }
  }
}

/** How far the sweep got; `null` when the status cannot be read right now. */
export async function probeLibraryStatus(): Promise<ProbeLibraryStatus | null> {
  try {
    const res = await apiFetch('/api/mixer/probe-library/status', {})
    if (!res.ok) return null
    return await res.json() as ProbeLibraryStatus
  } catch {
    return null
  }
}
