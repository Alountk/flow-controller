import type { ProbeFile, ProbeSubtitleTrack, ProbeVideoTrack } from '../api/probe.ts'
import { channelLabel, codecLabel, formatBitrate, formatFps } from '../../pages/MediaMixer.tsx'
import { formatSize } from '../hooks/useFilesNavigator.ts'

/* ── S3 preview labels (L7: the preview WINS over the helpers' words) ──────── */

// ffprobe's format_name names the demuxer family («matroska,webm»); the
// preview names the CONTAINER («MKV»). Unknown families fall back to upper.
const CONTAINER_LABELS: Record<string, string> = {
  matroska: 'MKV', mov: 'MP4', avi: 'AVI', mpegts: 'TS', asf: 'WMV',
  ogg: 'OGG', flv: 'FLV', wav: 'WAV', flac: 'FLAC', mp3: 'MP3',
}

function containerLabel(format: string): string {
  const first = format.split(',')[0].trim().toLowerCase()
  return CONTAINER_LABELS[first] ?? first.toUpperCase()
}

// codecLabel says «AC-3»; the preview says «AC3» — the AC-3 family drops hyphens.
function audioCodecLabel(codec: string): string {
  const c = codec.toLowerCase()
  if (c === 'ac3') return 'AC3'
  if (c === 'eac3') return 'EAC3'
  return codecLabel(codec)
}

// The preview's languages are lowercase Spanish names («español»), never the
// selector labels «Castellano»/«Inglés» (LANGUAGE_LABELS in MediaMixer).
const AUDIO_LANGUAGES: Record<string, string> = {
  spa: 'español', es: 'español', eng: 'inglés', en: 'inglés',
  rus: 'ruso', ru: 'ruso', cat: 'catalán', ca: 'catalán',
  fra: 'francés', deu: 'alemán', ita: 'italiano', por: 'portugués',
  jpn: 'japonés', kor: 'coreano', zho: 'chino', und: 'desconocido',
}

function audioLanguageLabel(tag: string): string {
  const t = tag.toLowerCase()
  return AUDIO_LANGUAGES[t] ?? (t ? t.toUpperCase() : '')
}

// Subtitles: uppercase codes («ESP», «ENG») and the .srt extension — ffprobe
// says «subrip», the preview says «srt».
function subtitleLabel(t: ProbeSubtitleTrack): string {
  const code = t.language_code.toLowerCase()
  const lang = code === 'spa' ? 'ESP' : code.toUpperCase()
  const ext = t.codec.toLowerCase() === 'subrip' ? 'srt' : t.codec.toLowerCase()
  return `${lang} (${ext})`
}

// L8 hard rule: smpte2084 → «HDR», arib-std-b67 → «HLG», nothing else —
// «HDR10»/«Dolby Vision» are unprovable without side_data and never render.
function rangeLabel(v: ProbeVideoTrack): string | null {
  const transfer = v.color_transfer.toLowerCase()
  if (transfer === 'smpte2084') return 'HDR'
  if (transfer === 'arib-std-b67') return 'HLG'
  return null
}

/** «High@4.0» — level_idc 40 is 4.0; level 0 or profile «unknown» drop out. */
function profileLabel(v: ProbeVideoTrack): string {
  const profile = v.profile.toLowerCase() === 'unknown' ? '' : v.profile
  const level = v.level > 0 ? `@${(v.level / 10).toFixed(1)}` : ''
  return profile && level ? `${profile}${level}` : profile
}

// Footer «1h 35m»: zero components drop out — formatDuration(«1h 35m 00s»)
// and formatDurationLong(«1 h 35 min 0 s») both contradict the pinned line.
function formatDurationSpec(seconds: number): string {
  const total = Math.floor(seconds)
  if (!total) return '—'
  const parts = [
    { n: Math.floor(total / 3600), unit: 'h' },
    { n: Math.floor((total % 3600) / 60), unit: 'm' },
    { n: total % 60, unit: 's' },
  ]
  return parts.filter((part) => part.n > 0).map((part) => `${part.n}${part.unit}`).join(' ')
}

/** The S3 spec block, line by line — the header (class + filename) is the caller's. */
export interface ProbeSpec {
  specs: string
  audio: string[]
  subtitles: string | null
  footer: string
}

export function probeSpec(probe: ProbeFile): ProbeSpec {
  const v = probe.video_tracks[0]
  const lineParts = [
    containerLabel(probe.format),
    v ? [codecLabel(v.codec), profileLabel(v)].filter(Boolean).join(' ') : '',
    v && v.width && v.height ? `${v.width}×${v.height}` : '',
    v && v.bitrate ? formatBitrate(v.bitrate) : '',
    v && v.fps ? `${formatFps(v.fps)} fps` : '',
    v ? rangeLabel(v) : null,
  ]
  return {
    specs: lineParts.filter((part): part is string => Boolean(part)).join(' · '),
    audio: probe.audio_tracks.map((t, i) =>
      [
        `Audio ${i + 1}:`,
        audioCodecLabel(t.codec),
        t.channels ? channelLabel(t.channels) : '',
        t.bitrate ? formatBitrate(t.bitrate).replace(' ', '') : '',
        audioLanguageLabel(t.language),
      ]
        .filter(Boolean)
        .join(' '),
    ),
    subtitles: probe.subtitle_tracks.length
      ? `Subtítulos: ${probe.subtitle_tracks.map(subtitleLabel).join(', ')}`
      : null,
    footer: `${formatDurationSpec(probe.duration)} · ${formatSize(probe.size_bytes)}`,
  }
}
