import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeFile } from '../../../shared/api/probe.ts'

/**
 * Contract for `POST /api/mixer/probe-file` (the single-file probe): the
 * request shape, the `parse_probe_data` payload on 200, and the «nothing here
 * rejects» guarantee the picks panel relies on.
 */

// The verbatim `parse_probe_data` shape: every field the parser emits, no more.
const probePayload = {
  filename: 'movie.mkv',
  path: '/srv/media/movie.mkv',
  format: 'matroska,webm',
  duration: 5412.48,
  size_bytes: 734003200,
  video_tracks: [
    { index: 0, track_index: 0, codec: 'hevc', width: 3840, height: 2160, fps: 23.976, bitrate: 8000000, selected: false },
  ],
  audio_tracks: [
    { index: 1, track_index: 0, codec: 'ac3', language: 'spa', channels: 6, bitrate: 640000, default: true },
    { index: 2, track_index: 1, codec: 'aac', language: 'eng', channels: 2, bitrate: 192000, default: false },
  ],
  subtitle_tracks: [
    { index: 3, track_index: 0, codec: 'subrip', language: 'spa', language_code: 'spa', title: 'Forzados', forced: true, default: false, kind: 'text', extractable: true },
    { index: 4, track_index: 1, codec: 'hdmv_pgs_subtitle', language: 'eng', language_code: 'eng', title: '', forced: false, default: true, kind: 'bitmap', extractable: false },
  ],
}

function stubFetchJson(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status }),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('probeFile request', () => {
  it('POSTs {path} as JSON to /api/mixer/probe-file', async () => {
    const fetchSpy = stubFetchJson(200, probePayload)

    await probeFile('/srv/media/movie.mkv')

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/mixer/probe-file',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/srv/media/movie.mkv' }),
      }),
    )
  })
})

describe('probeFile success', () => {
  it('resolves ok:true with the probe payload intact', async () => {
    stubFetchJson(200, probePayload)

    const result = await probeFile('/srv/media/movie.mkv')

    expect(result).toEqual({ ok: true, probe: probePayload })
  })
})

describe('probeFile refusals', () => {
  it('carries the 403 detail from the body', async () => {
    stubFetchJson(403, { detail: 'Forbidden' })

    const result = await probeFile('/srv/media/movie.mkv')

    expect(result).toEqual({ ok: false, detail: 'Forbidden' })
  })

  it('carries the 400 detail from the body', async () => {
    stubFetchJson(400, { detail: 'File not found: /srv/media/gone.mkv' })

    const result = await probeFile('/srv/media/gone.mkv')

    expect(result).toEqual({ ok: false, detail: 'File not found: /srv/media/gone.mkv' })
  })

  it('falls back to HTTP <status> when the body carries no detail', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>boom</html>', { status: 500 }))

    const result = await probeFile('/srv/media/movie.mkv')

    expect(result).toEqual({ ok: false, detail: 'HTTP 500' })
  })
})

describe('probeFile transport failure', () => {
  it('resolves {ok:false, detail} instead of rejecting', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    const result = await probeFile('/srv/media/movie.mkv')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.detail).toContain('Error de conexión')
    }
  })
})
