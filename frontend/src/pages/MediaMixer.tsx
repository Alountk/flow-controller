import { useCallback, useEffect, useRef, useState, useContext } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { EventStreamContext } from '../shared/hooks/useEventStream.ts'
import type {
  ProbeResult,
  ProbeFile,
  AudioOrderedTrack,
  MuxTask,
  MuxConflict,
  MuxError,
  SubtitleTrack,
  TaskSubtitle,
} from '../shared/api/mixer.ts'
import {
  probeFiles,
  startMux,
  listTasks,
  getTask,
  searchTaskSubtitles,
  cancelTask,
  pauseTask,
  resumeTask,
} from '../shared/api/mixer.ts'
import { browsePath, fetchRoots } from '../shared/api/files.ts'
import { apiFetch } from '../shared/api/auth.ts'
import { ReleaseSearchModal, type ReleaseSearchItem } from '../features/release-search/ReleaseSearchModal.tsx'
import type { MixerLookupResponse } from '../shared/types.ts'
import './MediaMixer.css'

/** S7 — the lookup behind «Buscar en el indexador»: the backend parses the
 *  title from the filename and answers with the in-library movie, if any. */
async function lookupIndexerMovie(filename: string): Promise<MixerLookupResponse> {
  const res = await apiFetch('/api/mixer/lookup', {
    method: 'POST',
    body: JSON.stringify({ filename }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const msg = (typeof body.detail === 'string' ? body.detail : null) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return res.json() as Promise<MixerLookupResponse>
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

function formatSize(bytes: number): string {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++ }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** Compact duration (mockup 11's comparison cards): `1h 55m 42s`. */
function formatDuration(seconds: number): string {
  if (!seconds) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${h}h ${mm}m ${ss}s`
  if (m > 0) return `${m}m ${ss}s`
  return `${s}s`
}

/** Spaced duration (mockup 10's strip): `1 h 55 min 42 s`. */
function formatDurationLong(seconds: number): string {
  if (!seconds) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h} h ${m} min ${s} s`
  if (m > 0) return `${m} min ${s} s`
  return `${s} s`
}

function formatDelta(seconds: number): string {
  const d = Math.round(Math.abs(seconds))
  if (d < 60) return `${d} s`
  return `${Math.floor(d / 60)} min ${d % 60} s`
}

function formatBitrate(bps: number): string {
  if (!bps) return '—'
  const kbps = bps / 1000
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`
  return `${Math.round(kbps)} kbps`
}

function formatFps(fps: number): string {
  return fps ? fps.toFixed(3) : '—'
}

const LANGUAGE_LABELS: Record<string, string> = {
  spa: 'Castellano', eng: 'Inglés', rus: 'Ruso', cat: 'Catalán',
  fra: 'Francés', deu: 'Alemán', ita: 'Italiano', por: 'Portugués',
  jpn: 'Japonés', kor: 'Coreano', zho: 'Chino', und: 'Desconocido',
}

function langName(code: string): string {
  return LANGUAGE_LABELS[code] || code.toUpperCase()
}

const CODEC_LABELS: Record<string, string> = {
  h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', mpeg2video: 'MPEG-2',
  eac3: 'E-AC-3', ac3: 'AC-3', dts: 'DTS', aac: 'AAC', flac: 'FLAC',
  truehd: 'TrueHD', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis',
}

function codecLabel(codec: string): string {
  return CODEC_LABELS[codec.toLowerCase()] || codec.toUpperCase()
}

function channelLabel(channels: number): string {
  const known: Record<number, string> = { 1: '1.0', 2: '2.0', 6: '5.1', 8: '7.1' }
  return known[channels] || String(channels)
}

/** `bitmap: hdmv_pgs_subtitle` (T5's `detail`) → the family shown on the chip. */
function bitmapFamily(codec: string): string {
  const c = codec.toLowerCase()
  if (c.includes('pgs')) return 'PGS'
  if (c.includes('dvd') || c.includes('vobsub')) return 'VobSub'
  return codec.toUpperCase()
}

function detailCodec(detail: string): string {
  const idx = detail.indexOf(':')
  return idx >= 0 ? detail.slice(idx + 1).trim() : detail.trim()
}

function baseName(path: string | null): string {
  return path ? path.split('/').pop() || path : ''
}

/** Display-only mirror of the backend's `_title_from_filename` (S7's mockup
 *  line «Busca la película por el título del archivo — …»). The lookup itself
 *  still derives its title server-side. */
const RELEASE_TAG_RE = /\b(?:2160p|1080p|720p|x26[45]|h26[45]|hevc|web-?dl|webrip|bluray|bdrip|hdtv|dts|aac|ddp?5?[.\s]?1)\b/i

function displayTitle(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, '').replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim()
  const match = RELEASE_TAG_RE.exec(stem)
  const cut = (match ? stem.slice(0, match.index) : stem).replace(/\s+/g, ' ').trim().replace(/ -$/, '')
  return cut || stem
}

/** S2's fixed order: castellano → inglés → ruso → catalán. */
const ORDERED_LANGUAGES = ['spa', 'eng', 'rus', 'cat']

const STATUS_LABELS: Record<string, string> = {
  running: 'En curso',
  paused: 'Pausada',
  done: 'Completada',
  error: 'Error',
  cancelled: 'Cancelada',
  pending: 'Pendiente',
  unknown: 'Desconocida',
}

/* ── State machine ─────────────────────────────────────────────────────────── */

type Phase = 'idle' | 'results'

/* ── File picker (reusable for both panes) ─────────────────────────────────── */

interface FilePickerProps {
  label: string
  value: string
  onSelect: (path: string) => void
  roots: { path: string; name: string }[]
}

function FilePicker({ label, value, onSelect, roots }: FilePickerProps) {
  const [open, setOpen] = useState(false)
  const [selectedVolume, setSelectedVolume] = useState(roots[0]?.path || '')
  const [currentPath, setCurrentPath] = useState(roots[0]?.path || '')
  const [selected, setSelected] = useState<string | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  const { data: browseData } = useQuery({
    queryKey: ['mixer-browse', currentPath],
    queryFn: () => browsePath(currentPath),
    enabled: open && !!currentPath,
  })

  useEffect(() => {
    if (roots.length > 0 && !selectedVolume) {
      setSelectedVolume(roots[0].path)
      setCurrentPath(roots[0].path)
    }
  }, [roots, selectedVolume])

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) setOpen(false)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  function navigateTo(p: string) {
    setSelected(null)
    setCurrentPath(p)
  }

  function parentDir() {
    if (currentPath === selectedVolume) return selectedVolume
    const parts = currentPath.split('/')
    const parent = parts.slice(0, -1).join('/') || '/'
    if (parent.length < selectedVolume.length || !parent.startsWith(selectedVolume)) {
      return selectedVolume
    }
    return parent
  }

  function handleSelect(item: { path: string; is_dir: boolean }) {
    if (item.is_dir) {
      navigateTo(item.path)
    } else {
      onSelect(item.path)
      setOpen(false)
    }
  }

  const items = browseData?.ok ? browseData.items : []

  return (
    <>
      <div className="mixer-file-input">
        <div className="mixer-file-input-head">
          <span className="mixer-file-badge">{label.slice(-1)}</span>
          <span className="mixer-file-label">{label}</span>
          <button className="fm-action-btn" onClick={() => setOpen(true)}>
            Examinar…
          </button>
          {value && (
            <button className="fm-action-btn" onClick={() => onSelect('')}>
              Quitar
            </button>
          )}
        </div>
        <div className="mixer-file-row">
          <span className="mixer-file-path" title={value || 'Sin seleccionar'}>
            {value || 'Sin seleccionar'}
          </span>
        </div>
      </div>

      {open && (
        <div className="scan-modal-backdrop" onClick={handleBackdropClick}>
          <div className="scan-modal" ref={modalRef}>
            <div className="scan-modal-header">
              <div className="scan-selected-info">
                <span className="scan-selected-type">📂</span>
                <strong>Seleccionar {label}</strong>
              </div>
              <button className="scan-modal-close" onClick={() => setOpen(false)}>×</button>
            </div>
            <div className="scan-modal-body">
              <div className="scan-controls">
                <div className="scan-row">
                  <label className="scan-label">Volumen:</label>
                  <select
                    className="fm-volume-select"
                    value={selectedVolume}
                    onChange={(e) => {
                      setSelectedVolume(e.target.value)
                      setCurrentPath(e.target.value)
                      setSelected(null)
                    }}
                  >
                    {roots.map((r) => (
                      <option key={r.path} value={r.path}>{r.name}</option>
                    ))}
                  </select>
                  {currentPath && (
                    <button
                      className="fm-nav-btn"
                      onClick={() => navigateTo(parentDir())}
                      title="Subir"
                      disabled={currentPath === selectedVolume}
                    >
                      ⬆
                    </button>
                  )}
                </div>

                {currentPath && (
                  <div className="scan-path-list">
                    <div className="scan-current-path">{currentPath}</div>
                    {items.filter((i) => i.is_dir).map((dirItem) => (
                      <div
                        key={dirItem.path}
                        className="scan-folder-item"
                        onClick={() => navigateTo(dirItem.path)}
                      >
                        📁 {dirItem.name}
                      </div>
                    ))}
                    {items.filter((i) => i.is_dir).length === 0 && (
                      <div className="scan-no-subfolders">Sin subcarpetas</div>
                    )}
                  </div>
                )}

                {items.filter((i) => !i.is_dir).length > 0 && (
                  <div className="scan-file-list">
                    {items.filter((i) => !i.is_dir).map((file) => (
                      <div
                        key={file.path}
                        className={`scan-file-item ${selected === file.path ? 'selected' : ''}`}
                        onClick={() => setSelected(file.path)}
                        onDoubleClick={() => handleSelect(file)}
                      >
                        <span className="fm-icon">📄</span>
                        <span className="fm-name">{file.name}</span>
                        <span className="fm-size">{formatSize(file.size)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="scan-actions">
                <button
                  className="action-btn"
                  disabled={!selected}
                  onClick={() => {
                    if (selected) {
                      onSelect(selected)
                      setOpen(false)
                    }
                  }}
                >
                  Seleccionar archivo
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/* ── File cards (mockups 10/11 — the A|B comparison) ───────────────────────── */

function FileCard({ file, label, mismatch }: {
  file: ProbeFile
  label: 'A' | 'B'
  /** fps/duration values the cotejo flagged for this file (red, mockup 11). */
  mismatch: { fps: boolean; duration: boolean }
}) {
  const fps = file.video_tracks[0]?.fps ?? 0
  return (
    <div className="mixer-file-card">
      <div className="mixer-file-card-head">
        <span className="mixer-file-badge">{label}</span>
        <span className="mixer-file-card-title">Archivo {label}</span>
        <span className="mixer-file-format">{file.format}</span>
      </div>
      <p className="mixer-file-card-path">{file.path}</p>
      <div className="mixer-file-meta-grid">
        <div className="mixer-file-meta-row">
          <span className="mixer-meta-label">Duración:</span>
          <span className={`mixer-meta-value ${mismatch.duration ? 'bad' : ''}`}>{formatDurationLong(file.duration)}</span>
        </div>
        <div className="mixer-file-meta-row">
          <span className="mixer-meta-label">FPS:</span>
          <span className={`mixer-meta-value ${mismatch.fps ? 'bad' : ''}`}>{formatFps(fps)}</span>
        </div>
        <div className="mixer-file-meta-row">
          <span className="mixer-meta-label">Tamaño:</span>
          <span className="mixer-meta-value">{formatSize(file.size_bytes)}</span>
        </div>
        <div className="mixer-file-meta-row">
          <span className="mixer-meta-label">Streams:</span>
          <span className="mixer-meta-value">
            {file.video_tracks.length} vídeo · {file.audio_tracks.length} audio · {(file.subtitle_tracks ?? []).length} subs
          </span>
        </div>
      </div>
    </div>
  )
}

/* ── Compatibility strip (S3 — mockups 10 green / 11 red) ──────────────────── */

function warnValue(type: string, value: string | number): string {
  if (type === 'duration_mismatch') return formatDuration(Number(value))
  if (type === 'fps_mismatch') return Number(value).toFixed(3)
  return String(value)
}

function CompatibilityStrip({ probe, ok }: { probe: ProbeResult; ok: boolean }) {
  const { file_a, file_b, compatibility } = probe
  const warnings = compatibility.warnings

  if (ok) {
    const fpsA = formatFps(file_a.video_tracks[0]?.fps ?? 0)
    const fpsB = formatFps(file_b.video_tracks[0]?.fps ?? 0)
    return (
      <section className="mixer-compat mixer-compat-ok">
        <div className="mixer-compat-head">
          <span className="mixer-badge mixer-badge-ok">
            <span className="mixer-badge-dot" aria-hidden="true" />
            Compatible
          </span>
          <span className="mixer-compat-note">Cotejo temporal y cadencia de fotogramas validado:</span>
        </div>
        <div className="mixer-compat-values">
          <span>{`fps A ${fpsA} · B ${fpsB}`}</span>
          <span className="mixer-compat-sep">|</span>
          <span>
            {`duración A ${formatDurationLong(file_a.duration)} · B ${formatDurationLong(file_b.duration)} `}
            <span className="mixer-delta">(Δ {formatDelta(file_a.duration - file_b.duration)})</span>
          </span>
        </div>
      </section>
    )
  }

  const reasonWarnings = warnings.filter(
    (w) =>
      (w.type === 'fps_mismatch' || w.type === 'duration_mismatch') &&
      (!(compatibility.reasons ?? []).length || (compatibility.reasons ?? []).includes(w.type)),
  )
  return (
    <section className="mixer-compat mixer-compat-bad">
      <div className="mixer-compat-head">
        <span className="mixer-badge mixer-badge-bad">
          <span className="mixer-badge-dot" aria-hidden="true" />
          No compatible
        </span>
        <span className="mixer-compat-note-strong">Cotejo temporal y cadencia de fotogramas fallido</span>
        <p className="mixer-compat-help">
          El mezclado se bloquea si los fps no coinciden o la duración difiere demasiado
        </p>
      </div>
      <div className="mixer-compat-cards">
        {reasonWarnings.map((w, i) => (
          <div key={i} className="mixer-compare-card">
            <span className="mixer-compare-label">{w.type === 'fps_mismatch' ? 'fps:' : 'duración:'}</span>
            <div className="mixer-compare-values">
              <span>A {warnValue(w.type, w.file_a_value)}</span>
              <span className="mixer-compat-sep">|</span>
              <span className="mixer-compare-bad">
                {`B ${warnValue(w.type, w.file_b_value)}${
                  w.type === 'duration_mismatch'
                    ? ` (Δ ${formatDelta(Number(w.file_a_value) - Number(w.file_b_value))})`
                    : ''
                }`}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ── Task list (unchanged behavior — ssePollGate + darkModePolish contracts) ─ */

function TaskList({ tasks }: { tasks: MuxTask[] }) {
  const queryClient = useQueryClient()

  const cancelMut = useMutation({
    mutationFn: cancelTask,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mixer-tasks'] }),
  })

  const pauseMut = useMutation({
    mutationFn: pauseTask,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mixer-tasks'] }),
  })

  const resumeMut = useMutation({
    mutationFn: resumeTask,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mixer-tasks'] }),
  })

  if (!tasks.length) return null

  return (
    <div className="mixer-task-list">
      <div className="mixer-task-list-header">Tareas</div>
      {tasks.map((task) => (
        <div key={task.task_id} className={`mixer-task mixer-task-${task.status}`}>
          <div className="mixer-task-info">
            <span className={`mixer-task-status mixer-status-${task.status}`}>
              {STATUS_LABELS[task.status] || task.status}
            </span>
            <span className="mixer-task-detail">{task.detail}</span>
            {task.output_path && (
              <span className="mixer-task-output" title={task.output_path}>
                → {task.output_path.split('/').pop()}
              </span>
            )}
          </div>
          {(task.status === 'running' || task.status === 'paused') && (
            <div className="mixer-task-progress">
              <div className="mixer-progress-bar">
                <div
                  className="mixer-progress-fill"
                  style={{ width: `${Math.round(task.progress * 100)}%` }}
                />
              </div>
              <span className="mixer-progress-pct">{Math.round(task.progress * 100)}%</span>
            </div>
          )}
          <div className="mixer-task-actions">
            {task.status === 'running' && (
              <>
                <button
                  className="action-btn"
                  onClick={() => pauseMut.mutate(task.task_id)}
                  disabled={pauseMut.isPending}
                >
                  ⏸ Pausar
                </button>
                <button
                  className="action-btn destructive"
                  onClick={() => cancelMut.mutate(task.task_id)}
                  disabled={cancelMut.isPending}
                >
                  ✕ Cancelar tarea
                </button>
              </>
            )}
            {task.status === 'paused' && (
              <>
                <button
                  className="action-btn"
                  onClick={() => resumeMut.mutate(task.task_id)}
                  disabled={resumeMut.isPending}
                >
                  ▶ Reanudar
                </button>
                <button
                  className="action-btn destructive"
                  onClick={() => cancelMut.mutate(task.task_id)}
                  disabled={cancelMut.isPending}
                >
                  ✕ Cancelar tarea
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ── Subtitle panel state (S6) ─────────────────────────────────────────────── */

interface SubtitleRowState {
  chip: string
  tone: 'ok' | 'info' | 'warn' | 'dim'
  detail: string
}

function subtitleRowState(
  entry: TaskSubtitle | undefined,
  candidate: { extractable: boolean; codec: string } | null,
  searching: boolean,
): SubtitleRowState {
  if (searching) return { chip: 'Buscando…', tone: 'dim', detail: 'consultando hash…' }
  if (entry) {
    if (entry.status === 'failed' || entry.detail === 'not_found') {
      return { chip: 'No encontrado', tone: 'dim', detail: '' }
    }
    switch (entry.status) {
      case 'extracted':
        return { chip: 'Extraído', tone: 'ok', detail: baseName(entry.sidecar) }
      case 'downloaded':
        return { chip: 'OpenSubtitles', tone: 'info', detail: baseName(entry.sidecar) || 'descargado' }
      case 'not_extractable':
        return {
          chip: `No extraíble (bitmap ${bitmapFamily(detailCodec(entry.detail))})`,
          tone: 'warn',
          detail: 'requiere OCR',
        }
      case 'missing':
        return { chip: 'Sin pista embebida', tone: 'dim', detail: '' }
      case 'skipped':
        return { chip: 'Omitida', tone: 'dim', detail: '' }
      case 'pending':
      default:
        return { chip: 'Pendiente', tone: 'dim', detail: '' }
    }
  }
  // No mux task yet — the probe alone tells what A/B can offer (S6 candidate).
  if (candidate?.extractable) return { chip: 'Extraíble', tone: 'info', detail: candidate.codec }
  if (candidate) {
    return {
      chip: `No extraíble (bitmap ${bitmapFamily(candidate.codec)})`,
      tone: 'warn',
      detail: 'requiere OCR',
    }
  }
  return { chip: 'Sin pista embebida', tone: 'dim', detail: '' }
}

const SEARCHABLE_STATUSES = ['missing', 'not_extractable', 'failed']

/** Row key: the file + the track's ordinal inside it (L18). */
function audioKey(entry: { file: string; track_index: number }): string {
  return `${entry.file}:${entry.track_index}`
}

/* ── Main Component ────────────────────────────────────────────────────────── */

export function MediaMixer() {
  const queryClient = useQueryClient()
  // B1: while the SSE stream is connected, mixer task events replace the poll
  // below (`refetchInterval` → false); a disconnect wakes it back up.
  const { connected } = useContext(EventStreamContext)
  const [phase, setPhase] = useState<Phase>('idle')
  const [pathA, setPathA] = useState('')
  const [pathB, setPathB] = useState('')
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [muxConflict, setMuxConflict] = useState<MuxConflict | null>(null)
  const [lookupNotice, setLookupNotice] = useState<string | null>(null)
  const [releaseSearchItem, setReleaseSearchItem] = useState<ReleaseSearchItem | null>(null)

  // Selection state: video = row key (`file:ordinal`), audio = row keys
  // (L18 — ordinals, never the absolute ffprobe `index`).
  const [selectedVideoKey, setSelectedVideoKey] = useState<string | null>(null)
  const [checkedAudio, setCheckedAudio] = useState<Set<string>>(new Set())

  // Poll tasks while any are active
  const { data: tasksData } = useQuery({
    queryKey: ['mixer-tasks'],
    queryFn: listTasks,
    refetchInterval: connected ? false : (query) => {
      const tasks = query.state.data?.tasks ?? []
      const hasActive = tasks.some((t) => t.status === 'running' || t.status === 'paused')
      return hasActive ? 2000 : 10000
    },
  })

  const { data: rootsData } = useQuery({
    queryKey: ['roots'],
    queryFn: fetchRoots,
  })

  const roots = rootsData?.roots ?? []
  const tasks = tasksData?.tasks ?? []
  const latestTask = tasks.reduce<MuxTask | undefined>(
    (best, t) => (!best || t.created_at > best.created_at ? t : best),
    undefined,
  )

  // The subtitles panel rides on the newest task (S6: the task's `subtitles`
  // entries resolve what the probe could only propose).
  const { data: taskDetail } = useQuery({
    queryKey: ['mixer-task', latestTask?.task_id],
    queryFn: () => getTask(latestTask!.task_id),
    enabled: !!latestTask?.task_id,
  })
  const taskSubtitles: TaskSubtitle[] = taskDetail?.subtitles ?? []

  // Merged video rows: file A's tracks then file B's (mockup 10). Ordinals for
  // `-map v:N` come from `track_index` (array position), never `index` (L18).
  const videoRows = (() => {
    const rows: { key: string; file: 'a' | 'b'; path: string; track_index: number; track: ProbeFile['video_tracks'][number]; best: boolean }[] = []
    const best = probeResult?.best_video
    const bestKey = best ? `${best.file}:${best.track_index}` : null
    for (const [label, file] of [['a', probeResult?.file_a], ['b', probeResult?.file_b]] as const) {
      if (!file) continue
      file.video_tracks.forEach((track, i) => {
        const ordinal = track.track_index ?? i
        const key = `${label}:${ordinal}`
        rows.push({ key, file: label, path: file.path, track_index: ordinal, track, best: key === bestKey })
      })
    }
    return rows
  })()

  // Merged audio rows in the order the backend delivered them (S2/S5).
  const audioRows = (probeResult?.audio_ordered ?? []).map((entry: AudioOrderedTrack) => ({
    key: audioKey(entry),
    entry,
    file: entry.file,
    track_index: entry.track_index,
  }))

  const audioCheckedCount = audioRows.filter((r) => checkedAudio.has(r.key)).length
  const otherAudioCount = audioRows.filter(
    (r) => !ORDERED_LANGUAGES.includes(r.entry.language_code),
  ).length

  // Subtitle rows: one per audio language, in the same delivered order.
  const subtitleRows = (() => {
    const seen = new Set<string>()
    const rows: {
      code: string
      entry: TaskSubtitle | undefined
      candidate: { extractable: boolean; codec: string } | null
      searchable: boolean
    }[] = []
    for (const row of audioRows) {
      const code = row.entry.language_code
      if (!code || seen.has(code)) continue
      seen.add(code)
      const tracks: SubtitleTrack[] = [
        ...(probeResult?.file_a.subtitle_tracks ?? []),
        ...(probeResult?.file_b.subtitle_tracks ?? []),
      ].filter((t) => t.language_code === code)
      const extractable = tracks.find((t) => t.extractable)
      const candidate = extractable
        ? { extractable: true, codec: extractable.codec }
        : tracks[0]
          ? { extractable: false, codec: tracks[0].codec }
          : null
      const entry = taskSubtitles.find((s) => s.language_code === code)
      rows.push({
        code,
        entry,
        candidate,
        searchable: !!entry && SEARCHABLE_STATUSES.includes(entry.status),
      })
    }
    return rows
  })()

  const probeMut = useMutation({
    mutationFn: () => probeFiles(pathA, pathB),
    onSuccess: (result) => {
      setProbeResult(result)
      setLookupNotice(null)
      setError(null)
      setMuxConflict(null)
      // S4: auto-select the best video across A and B (`best_video` may name B).
      const best = result.best_video
      const firstRow = result.file_a.video_tracks[0]
        ? `a:${result.file_a.video_tracks[0].track_index ?? 0}`
        : result.file_b.video_tracks[0]
          ? `b:${result.file_b.video_tracks[0].track_index ?? 0}`
          : null
      setSelectedVideoKey(best ? `${best.file}:${best.track_index}` : firstRow)
      // S5: the «4 automáticas» come pre-checked (backend `selected` marks).
      setCheckedAudio(
        new Set((result.audio_ordered ?? []).filter((e) => e.selected).map(audioKey)),
      )
      setPhase('results')
    },
    onError: (err: Error) => {
      setError(err.message)
    },
  })

  const muxMut = useMutation({
    mutationFn: () => {
      if (!probeResult || !selectedVideoKey) throw new Error('Invalid state')
      const videoRow = videoRows.find((r) => r.key === selectedVideoKey)
      if (!videoRow) throw new Error('Invalid state')

      // Payload contract (L18): checked rows in rendered order, each with the
      // path of its own file and its ordinal `track_index`.
      const audioSources = audioRows
        .filter((r) => checkedAudio.has(r.key))
        .map((r) => ({
          path: r.file === 'a' ? probeResult.file_a.path : probeResult.file_b.path,
          track_index: r.track_index,
        }))
      if (audioSources.length === 0) {
        throw new Error('Selecciona al menos una pista de audio')
      }

      return startMux({ path: videoRow.path, track_index: videoRow.track_index }, audioSources)
    },
    onSuccess: () => {
      setError(null)
      setMuxConflict(null)
      queryClient.invalidateQueries({ queryKey: ['mixer-tasks'] })
    },
    onError: (err: Error) => {
      setError(err.message)
      setMuxConflict((err as MuxError).conflict ?? null)
    },
  })

  // S7/L8 — «Botón con lookup automático»: the title comes from the filename
  // (file A first); an in-library movie opens `ReleaseSearchModal`, anything
  // else becomes the «añádela primero» notice, and a Radarr failure lands on
  // the same error surface as every other call in this page.
  const lookupMut = useMutation({
    mutationFn: (): Promise<MixerLookupResponse> => {
      const filename = probeResult?.file_a.filename || probeResult?.file_b.filename || ''
      return lookupIndexerMovie(filename)
    },
    onSuccess: (data) => {
      setError(null)
      if (data.movie) {
        setLookupNotice(null)
        setReleaseSearchItem({
          type: 'movie',
          id: data.movie.id,
          title: data.movie.title,
          year: data.movie.year,
          source: data.movie.source,
          idKind: 'movie',
        })
      } else {
        setLookupNotice(`${data.title} no está en la librería — añádela primero en Radarr`)
      }
    },
    onError: (err: Error) => {
      setError(err.message)
    },
  })

  // S6 — «Buscar subtítulos»: only the entries extraction could not give,
  // narrowed to their three-letter codes; the task refresh flips the chips.
  const searchMut = useMutation({
    mutationFn: () => {
      if (!latestTask) throw new Error('No task')
      const codes = subtitleRows
        .filter((r) => r.searchable)
        .map((r) => r.code)
      return searchTaskSubtitles(latestTask.task_id, codes)
    },
    onSuccess: () => {
      setError(null)
      queryClient.invalidateQueries({ queryKey: ['mixer-task', latestTask?.task_id] })
    },
    onError: (err: Error) => {
      setError(err.message)
    },
  })

  function resetAll() {
    setPhase('idle')
    setPathA('')
    setPathB('')
    setProbeResult(null)
    setError(null)
    setMuxConflict(null)
    setLookupNotice(null)
    setReleaseSearchItem(null)
    setSelectedVideoKey(null)
    setCheckedAudio(new Set())
  }

  function toggleAudio(key: string) {
    setCheckedAudio((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // S3/L14 — `canMux` needs compatibility.ok AND language_check.ok plus real
  // selections; the mockup-11 «Mezclar» carries a real `disabled` attribute.
  const compatOk =
    probeResult != null &&
    probeResult.compatibility.ok &&
    muxConflict?.error !== 'incompatible'
  const langOk = probeResult?.language_check?.ok === true
  const canProbe = pathA !== '' && pathB !== '' && phase === 'idle'
  const canMux =
    phase === 'results' &&
    selectedVideoKey !== null &&
    audioCheckedCount > 0 &&
    compatOk &&
    langOk
  const canSearch = !!latestTask && subtitleRows.some((r) => r.searchable)
  const activeTasks = tasks.filter((t) => t.status === 'running' || t.status === 'paused')

  const mismatch = {
    fps: (probeResult?.compatibility.warnings ?? []).some((w) => w.type === 'fps_mismatch'),
    duration: (probeResult?.compatibility.warnings ?? []).some((w) => w.type === 'duration_mismatch'),
  }

  return (
    <section className="mixer">
      <div className="mixer-header">
        <h2>
          Media Mixer <span className="mixer-engine-chip">remux engine v3</span>
        </h2>
        <p>Mezcla de dos archivos · vídeo + audio ordenado · subtítulos externos</p>
      </div>

      {/* ── File Selection ──────────────────────────────────────────────── */}
      {phase === 'idle' && (
        <div className="mixer-section">
          <div className="mixer-file-selections">
            <FilePicker
              label="Archivo A"
              value={pathA}
              onSelect={setPathA}
              roots={roots}
            />
            <FilePicker
              label="Archivo B"
              value={pathB}
              onSelect={setPathB}
              roots={roots}
            />
          </div>

          <div className="mixer-actions">
            <button
              className="action-btn"
              disabled={!canProbe || probeMut.isPending}
              onClick={() => probeMut.mutate()}
            >
              {probeMut.isPending ? 'Cotejando…' : 'Cotejar archivos'}
            </button>
          </div>

          {error && <div className="fm-error">{error}</div>}
        </div>
      )}

      {/* ── Probing indicator ───────────────────────────────────────────── */}
      {phase === 'idle' && probeMut.isPending && (
        <div className="mixer-loading">
          <div className="mixer-spinner" />
          <span>Ejecutando ffprobe sobre los dos archivos…</span>
        </div>
      )}

      {/* ── Probe results — the mockup 10/11/12 workspace ───────────────── */}
      {phase === 'results' && probeResult && (
        <>
          {/* 1) A|B comparison */}
          <div className="mixer-compare">
            <FileCard file={probeResult.file_a} label="A" mismatch={{ fps: mismatch.fps, duration: mismatch.duration }} />
            <FileCard file={probeResult.file_b} label="B" mismatch={{ fps: mismatch.fps, duration: mismatch.duration }} />
          </div>

          {/* 2) Compatibility strip spanning both columns */}
          <CompatibilityStrip
            probe={probeResult}
            ok={compatOk}
          />

          {/* 3) Vídeo — mejor calidad y compresión (S4) */}
          <section className="mixer-panel">
            <div className="mixer-panel-head">
              <div>
                <h3 className="mixer-panel-title">Vídeo — mejor calidad y compresión</h3>
                <p className="mixer-panel-sub">
                  {'Se elige automáticamente la mejor pista entre A y B (resolución > codec > bitrate)'}
                </p>
              </div>
              <span className="mixer-panel-aside">
                {selectedVideoKey ? `Pista ${selectedVideoKey.split(':')[1]}` : '—'}
              </span>
            </div>
            <div className="mixer-video-list">
              {videoRows.map((row) => (
                <label
                  key={row.key}
                  className={`mixer-video-row ${selectedVideoKey === row.key ? 'selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="mixer-video"
                    checked={selectedVideoKey === row.key}
                    onChange={() => setSelectedVideoKey(row.key)}
                  />
                  <span className={`mixer-row-file mixer-row-file-${row.file}`}>{row.file.toUpperCase()}</span>
                  <span className="mixer-video-spec">
                    <span className="mixer-row-main">{row.track.height}p</span>
                    <span className="mixer-meta-label">·</span>
                    <span className="mixer-row-main">{codecLabel(row.track.codec)}</span>
                    <span className="mixer-meta-label">·</span>
                    <span className="mixer-row-main">{formatBitrate(row.track.bitrate)}</span>
                  </span>
                  {row.best ? (
                    <span className="mixer-chip-best">Auto · mejor compresión</span>
                  ) : (
                    <span className="mixer-row-label">Pista original {row.file.toUpperCase()}</span>
                  )}
                </label>
              ))}
            </div>
          </section>

          {/* 4) Pistas de audio — the merged list (S2/S5) */}
          <section className="mixer-panel">
            <div className="mixer-panel-head">
              <div>
                <h3 className="mixer-panel-title">Pistas de audio</h3>
                <p className="mixer-panel-sub">
                  Orden fijo: castellano → inglés → ruso → catalán · se preseleccionan los 4 idiomas
                </p>
              </div>
              <span className="mixer-panel-aside">
                {audioCheckedCount} seleccionadas · {audioRows.length - audioCheckedCount} omitidas
              </span>
            </div>

            {/* S2/L14 + mockup 12 — missing required language banner */}
            {probeResult.language_check?.ok === false && (
              <div className="mixer-lang-notice">
                <span className="mixer-lang-notice-icon" aria-hidden="true">⚠</span>
                <div className="mixer-lang-notice-body">
                  <div className="mixer-lang-notice-title-row">
                    <span className="mixer-lang-notice-title">
                      Falta castellano (exigido) en los dos archivos
                    </span>
                    <span className="mixer-badge-blocking">Bloqueante</span>
                  </div>
                  <p className="mixer-lang-notice-text">
                    Castellano es el mínimo obligatorio; basta con que lo tenga uno de los dos archivos.
                  </p>
                  <p className="mixer-lang-notice-hint">
                    Busca la película por el título del archivo —{' '}
                    <span className="mixer-mono">
                      {displayTitle(probeResult.file_a.filename || probeResult.file_b.filename)}
                    </span>{' '}
                    — y abre sus releases.
                  </p>
                </div>
                <button
                  className="mixer-btn-indexer"
                  disabled={lookupMut.isPending}
                  onClick={() => lookupMut.mutate()}
                >
                  Buscar en el indexador
                </button>
              </div>
            )}

            {lookupNotice && <div className="mixer-lookup-notice">{lookupNotice}</div>}

            <div className="mixer-audio-list">
              {audioRows.map((row, i) => {
                const isOther = !ORDERED_LANGUAGES.includes(row.entry.language_code)
                const prevOther = i > 0 && !ORDERED_LANGUAGES.includes(audioRows[i - 1].entry.language_code)
                const showGroup = isOther && !prevOther
                const checked = checkedAudio.has(row.key)
                const orderNum = audioRows
                  .slice(0, i + 1)
                  .filter((r) => checkedAudio.has(r.key)).length
                return (
                  <div key={row.key}>
                    {showGroup && (
                      <div className="mixer-subgroup-head">
                        <span>Otros idiomas · elegir a mano</span>
                        <span className="mixer-panel-aside">{otherAudioCount} disponibles</span>
                      </div>
                    )}
                    <label className="mixer-audio-row">
                      <span className="mixer-audio-num">{checked ? orderNum : '—'}</span>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAudio(row.key)}
                      />
                      <span className="mixer-lang-name">{langName(row.entry.language_code)}</span>
                      <span className="mixer-lang-chip">{row.entry.language_code}</span>
                      <span className="mixer-audio-spec">
                        <span className="mixer-meta-label">·</span>
                        <span className="mixer-row-main">{codecLabel(row.entry.codec)}</span>
                        <span className="mixer-meta-label">·</span>
                        <span className="mixer-row-main">{channelLabel(row.entry.channels)}</span>
                        <span className="mixer-meta-label">·</span>
                        <span className="mixer-row-main">{formatBitrate(row.entry.bitrate)}</span>
                      </span>
                      <span className={`mixer-row-file mixer-row-file-${row.file}`}>Archivo {row.file.toUpperCase()}</span>
                      {row.entry.selected && <span className="mixer-chip-auto">Auto</span>}
                    </label>
                  </div>
                )
              })}
            </div>
          </section>

          {/* 5) Subtítulos externos (.srt) — S6/S8 */}
          <section className="mixer-panel">
            <div className="mixer-panel-head">
              <div>
                <h3 className="mixer-panel-title">Subtítulos externos (.srt)</h3>
                <p className="mixer-panel-sub">
                  Sincronización sidecar de pistas de texto para reproductores multimedia
                </p>
              </div>
            </div>

            <div className="mixer-sub-list">
              {subtitleRows.map((row) => {
                const state = subtitleRowState(
                  row.entry,
                  row.candidate,
                  searchMut.isPending && row.searchable,
                )
                return (
                  <div key={row.code} className="mixer-sub-row">
                    <div className="mixer-sub-row-left">
                      <span className="mixer-sub-lang">{langName(row.code)}</span>
                      <span className={`mixer-sub-chip mixer-sub-chip-${state.tone}`}>{state.chip}</span>
                    </div>
                    {state.detail && <span className="mixer-sub-detail">{state.detail}</span>}
                  </div>
                )
              })}
            </div>

            <div className="mixer-sub-actions">
              <button
                className="mixer-btn-secondary"
                disabled={!canSearch || searchMut.isPending}
                onClick={() => searchMut.mutate()}
              >
                Buscar subtítulos
              </button>
            </div>

            <div className="mixer-dim-notes">
              <p>Clave API de OpenSubtitles: Configuración → Servicios</p>
              <p>Los subtítulos embebidos no se copian al contenedor · solo .srt junto a la salida</p>
            </div>
          </section>

          {/* 6) Action row (S8) */}
          <div className="mixer-actionbar">
            <div className="mixer-actionbar-info">
              {latestTask?.output_path && (
                <div className="mixer-destino">
                  <span className="mixer-meta-label">Destino:</span>{' '}
                  <span className="mixer-mono">{latestTask.output_path}</span>
                </div>
              )}
              <p className="mixer-copy-note">copia de streams, sin transcodificar (-c copy)</p>
            </div>
            <div className="mixer-actionbar-buttons">
              {!compatOk && (
                <div className="mixer-blocked-note">
                  <span aria-hidden="true">⚠</span>
                  <span className="mixer-blocked-text">
                    Mezclado bloqueado: los fps o la duración no coinciden entre A y B
                  </span>
                </div>
              )}
              <button className="mixer-btn-secondary" onClick={resetAll}>
                Cancelar
              </button>
              <button
                className="mixer-btn-primary"
                disabled={!canMux || muxMut.isPending}
                onClick={() => muxMut.mutate()}
              >
                Mezclar
              </button>
            </div>
          </div>

          {error && <div className="fm-error">{error}</div>}
        </>
      )}

      {/* ── Task list (idle or results) ──────────────────────────────────── */}
      {tasksData && tasksData.tasks.length > 0 && (
        <div className="mixer-section">
          <TaskList tasks={tasksData.tasks} />
          {activeTasks.length === 0 && phase === 'idle' && (
            <div className="mixer-actions">
              <button className="action-btn" onClick={resetAll}>
                ← Nueva mezcla
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Releases of the movie the indexer lookup found (S7) ───────── */}
      {releaseSearchItem && (
        <ReleaseSearchModal item={releaseSearchItem} onClose={() => setReleaseSearchItem(null)} />
      )}
    </section>
  )
}
