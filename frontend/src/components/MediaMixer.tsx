import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  ProbeResult,
  ProbeFile,
  AudioTrack,
  VideoTrack,
  MuxTask,
} from '../api/mixer'
import {
  probeFiles,
  startMux,
  listTasks,
  cancelTask,
  pauseTask,
  resumeTask,
} from '../api/mixer'
import { browsePath, fetchRoots } from '../api/files'
import './MediaMixer.css'

/* ── Helpers ───────────────────────────────────────────────────────────────── */

function formatSize(bytes: number): string {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++ }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDuration(seconds: number): string {
  if (!seconds) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatBitrate(bps: number): string {
  if (!bps) return '—'
  const kbps = bps / 1000
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`
  return `${Math.round(kbps)} kbps`
}

const LANGUAGE_LABELS: Record<string, string> = {
  eng: 'English', spa: 'Spanish', fra: 'French', deu: 'German',
  ita: 'Italian', por: 'Portuguese', jpn: 'Japanese', kor: 'Korean',
  zho: 'Chinese', rus: 'Russian', und: 'Unknown',
}

function langName(code: string): string {
  return LANGUAGE_LABELS[code] || code.toUpperCase()
}

const STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  paused: 'Paused',
  done: 'Complete',
  error: 'Error',
  cancelled: 'Cancelled',
  pending: 'Pending',
  unknown: 'Unknown',
}

/* ── State machine ─────────────────────────────────────────────────────────── */

type Phase = 'idle' | 'probing' | 'results' | 'mixing'

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
        <span className="mixer-file-label">{label}</span>
        <div className="mixer-file-row">
          <span className="mixer-file-path" title={value || 'Not selected'}>
            {value || 'Not selected'}
          </span>
          <button className="fm-action-btn" onClick={() => setOpen(true)}>
            Browse
          </button>
          {value && (
            <button className="fm-action-btn" onClick={() => onSelect('')}>
              Clear
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="scan-modal-backdrop" onClick={handleBackdropClick}>
          <div className="scan-modal" ref={modalRef}>
            <div className="scan-modal-header">
              <div className="scan-selected-info">
                <span className="scan-selected-type">📂</span>
                <strong>Select {label}</strong>
              </div>
              <button className="scan-modal-close" onClick={() => setOpen(false)}>×</button>
            </div>
            <div className="scan-modal-body">
              <div className="scan-controls">
                <div className="scan-row">
                  <label className="scan-label">Volume:</label>
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
                      title="Go up"
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
                      <div className="scan-no-subfolders">No subfolders</div>
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
                  Select File
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/* ── Compatibility warnings ────────────────────────────────────────────────── */

function WarningsPanel({ warnings }: { warnings: ProbeResult['compatibility']['warnings'] }) {
  if (!warnings.length) return null

  return (
    <div className="mixer-warnings">
      <div className="mixer-warnings-header">⚠️ Compatibility Warnings</div>
      {warnings.map((w, i) => (
        <div key={i} className="mixer-warning">
          <span className={`mixer-warning-icon ${w.type === 'duration_mismatch' ? 'warn' : 'error'}`}>
            {w.type === 'duration_mismatch' ? '⏱' : '⚡'}
          </span>
          <span>{w.message}</span>
        </div>
      ))}
    </div>
  )
}

/* ── Track selection for probe results ─────────────────────────────────────── */

interface TrackSelectorProps {
  file: ProbeFile
  label: string
  selectedVideo: number | null
  selectedAudio: number[]
  onVideoSelect: (index: number) => void
  onAudioToggle: (index: number) => void
  onAudioReorder: (from: number, to: number) => void
}

function TrackSelector({
  file,
  label,
  selectedVideo,
  selectedAudio,
  onVideoSelect,
  onAudioToggle,
  onAudioReorder,
}: TrackSelectorProps) {
  return (
    <div className="mixer-track-selector">
      <div className="mixer-file-header">
        <span className="mixer-file-name">📄 {file.filename}</span>
        <span className="mixer-file-meta">
          {formatSize(file.size_bytes)} · {formatDuration(file.duration)} · {file.format}
        </span>
      </div>

      {file.video_tracks.length > 0 && (
        <div className="mixer-track-section">
          <div className="mixer-track-section-title">Video Tracks</div>
          {file.video_tracks.map((track: VideoTrack) => (
            <label
              key={track.index}
              className={`mixer-track ${selectedVideo === track.index ? 'selected' : ''}`}
            >
              <input
                type="radio"
                name={`video-${label}`}
                checked={selectedVideo === track.index}
                onChange={() => onVideoSelect(track.index)}
              />
              <div className="mixer-track-info">
                <span className="mixer-track-codec">{track.codec.toUpperCase()}</span>
                <span className="mixer-track-detail">{track.width}x{track.height}</span>
                <span className="mixer-track-detail">{track.fps} fps</span>
                <span className="mixer-track-detail">{formatBitrate(track.bitrate)}</span>
              </div>
            </label>
          ))}
        </div>
      )}

      {file.audio_tracks.length > 0 && (
        <div className="mixer-track-section">
          <div className="mixer-track-section-title">Audio Tracks</div>
          {file.audio_tracks.map((track: AudioTrack) => {
            const orderIdx = selectedAudio.indexOf(track.index)
            const isSelected = orderIdx >= 0
            return (
              <div
                key={track.index}
                className={`mixer-track ${isSelected ? 'selected' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onAudioToggle(track.index)}
                />
                <div className="mixer-track-info">
                  <span className="mixer-track-codec">{track.codec.toUpperCase()}</span>
                  <span className="mixer-track-detail">{langName(track.language)}</span>
                  <span className="mixer-track-detail">{track.channels}ch</span>
                  <span className="mixer-track-detail">{formatBitrate(track.bitrate)}</span>
                  {track.default && <span className="mixer-track-default">default</span>}
                </div>
                {isSelected && (
                  <div className="mixer-track-order">
                    <button
                      className="fm-sm-btn"
                      title="Move up"
                      disabled={orderIdx === 0}
                      onClick={() => onAudioReorder(orderIdx, orderIdx - 1)}
                    >
                      ▲
                    </button>
                    <span className="mixer-track-order-num">{orderIdx + 1}</span>
                    <button
                      className="fm-sm-btn"
                      title="Move down"
                      disabled={orderIdx === selectedAudio.length - 1}
                      onClick={() => onAudioReorder(orderIdx, orderIdx + 1)}
                    >
                      ▼
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ── Task list ─────────────────────────────────────────────────────────────── */

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
      <div className="mixer-task-list-header">Tasks</div>
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
                  ⏸ Pause
                </button>
                <button
                  className="action-btn destructive"
                  onClick={() => cancelMut.mutate(task.task_id)}
                  disabled={cancelMut.isPending}
                >
                  ✕ Cancel
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
                  ▶ Resume
                </button>
                <button
                  className="action-btn destructive"
                  onClick={() => cancelMut.mutate(task.task_id)}
                  disabled={cancelMut.isPending}
                >
                  ✕ Cancel
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ── Main Component ────────────────────────────────────────────────────────── */

export function MediaMixer() {
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<Phase>('idle')
  const [pathA, setPathA] = useState('')
  const [pathB, setPathB] = useState('')
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Track selection state
  const [selectedVideoA, setSelectedVideoA] = useState<number | null>(null)
  const [selectedVideoB, setSelectedVideoB] = useState<number | null>(null)
  const [selectedAudioA, setSelectedAudioA] = useState<number[]>([])
  const [selectedAudioB, setSelectedAudioB] = useState<number[]>([])

  // Poll tasks while any are active
  const { data: tasksData } = useQuery({
    queryKey: ['mixer-tasks'],
    queryFn: listTasks,
    refetchInterval: (query) => {
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

  const probeMut = useMutation({
    mutationFn: () => probeFiles(pathA, pathB),
    onSuccess: (result) => {
      setProbeResult(result)
      // Auto-select best video track for each file
      const bestVideoA = selectBestVideo(result.file_a.video_tracks)
      const bestVideoB = selectBestVideo(result.file_b.video_tracks)
      setSelectedVideoA(bestVideoA)
      setSelectedVideoB(bestVideoB)
      // Pre-select default audio tracks
      setSelectedAudioA(result.file_a.audio_tracks.filter((t) => t.default).map((t) => t.index))
      setSelectedAudioB(result.file_b.audio_tracks.filter((t) => t.default).map((t) => t.index))
      setPhase('results')
      setError(null)
    },
    onError: (err: Error) => {
      setError(err.message)
    },
  })

  const muxMut = useMutation({
    mutationFn: () => {
      if (!probeResult || selectedVideoA === null) throw new Error('Invalid state')

      const videoSource = {
        path: selectedVideoA !== null ? probeResult.file_a.path : probeResult.file_b.path,
        track_index: selectedVideoA !== null ? selectedVideoA : selectedVideoB!,
      }

      const audioSources: { path: string; track_index: number }[] = []
      for (const idx of selectedAudioA) {
        audioSources.push({ path: probeResult.file_a.path, track_index: idx })
      }
      for (const idx of selectedAudioB) {
        audioSources.push({ path: probeResult.file_b.path, track_index: idx })
      }

      if (audioSources.length === 0) {
        throw new Error('Select at least one audio track')
      }

      return startMux(videoSource, audioSources)
    },
    onSuccess: () => {
      setPhase('mixing')
      setError(null)
      queryClient.invalidateQueries({ queryKey: ['mixer-tasks'] })
    },
    onError: (err: Error) => {
      setError(err.message)
    },
  })

  function selectBestVideo(tracks: VideoTrack[]): number | null {
    if (!tracks.length) return null
    const CODEC_PRIORITY: Record<string, number> = { hevc: 0, h265: 0, h264: 1, avc: 1 }
    let bestIdx = 0
    let bestPriority = 999
    for (let i = 0; i < tracks.length; i++) {
      const codec = tracks[i].codec.toLowerCase()
      const priority = CODEC_PRIORITY[codec] ?? 2
      if (priority < bestPriority) {
        bestPriority = priority
        bestIdx = i
      }
    }
    return tracks[bestIdx].index
  }

  function toggleAudio(fileIndex: 'a' | 'b', trackIndex: number) {
    const setter = fileIndex === 'a' ? setSelectedAudioA : setSelectedAudioB
    setter((prev) => {
      if (prev.includes(trackIndex)) {
        return prev.filter((i) => i !== trackIndex)
      }
      return [...prev, trackIndex]
    })
  }

  function reorderAudio(fileIndex: 'a' | 'b', from: number, to: number) {
    const setter = fileIndex === 'a' ? setSelectedAudioA : setSelectedAudioB
    setter((prev) => {
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
  }

  function resetAll() {
    setPhase('idle')
    setPathA('')
    setPathB('')
    setProbeResult(null)
    setError(null)
    setSelectedVideoA(null)
    setSelectedVideoB(null)
    setSelectedAudioA([])
    setSelectedAudioB([])
  }

  const canProbe = pathA !== '' && pathB !== '' && phase === 'idle'
  const canMux = phase === 'results' && selectedVideoA !== null && (selectedAudioA.length > 0 || selectedAudioB.length > 0)
  const activeTasks = tasksData?.tasks.filter((t) => t.status === 'running' || t.status === 'paused') ?? []

  return (
    <section className="mixer">
      <div className="mixer-header">
        <h2>Media Mixer</h2>
        <p>Mux video and audio tracks from separate files using ffmpeg stream copy</p>
      </div>

      {/* ── File Selection ──────────────────────────────────────────────── */}
      {phase === 'idle' && (
        <div className="mixer-section">
          <div className="mixer-file-selections">
            <FilePicker
              label="Video Source"
              value={pathA}
              onSelect={setPathA}
              roots={roots}
            />
            <FilePicker
              label="Audio Source"
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
              {probeMut.isPending ? '⏳ Probing...' : '🔍 Probe Files'}
            </button>
          </div>

          {error && <div className="fm-error">{error}</div>}
        </div>
      )}

      {/* ── Probing indicator ───────────────────────────────────────────── */}
      {phase === 'idle' && probeMut.isPending && (
        <div className="mixer-loading">
          <div className="mixer-spinner" />
          <span>Running ffprobe on both files...</span>
        </div>
      )}

      {/* ── Probe Results & Track Selection ─────────────────────────────── */}
      {phase === 'results' && probeResult && (
        <div className="mixer-section">
          <WarningsPanel warnings={probeResult.compatibility.warnings} />

          <div className="mixer-track-selectors">
            <TrackSelector
              file={probeResult.file_a}
              label="a"
              selectedVideo={selectedVideoA}
              selectedAudio={selectedAudioA}
              onVideoSelect={setSelectedVideoA}
              onAudioToggle={(idx) => toggleAudio('a', idx)}
              onAudioReorder={(from, to) => reorderAudio('a', from, to)}
            />
            <TrackSelector
              file={probeResult.file_b}
              label="b"
              selectedVideo={selectedVideoB}
              selectedAudio={selectedAudioB}
              onVideoSelect={setSelectedVideoB}
              onAudioToggle={(idx) => toggleAudio('b', idx)}
              onAudioReorder={(from, to) => reorderAudio('b', from, to)}
            />
          </div>

          <div className="mixer-actions">
            <button
              className="action-btn"
              onClick={resetAll}
            >
              ← Back
            </button>
            <button
              className="action-btn"
              disabled={!canMux || muxMut.isPending}
              onClick={() => muxMut.mutate()}
            >
              {muxMut.isPending ? '⏳ Starting...' : '🎬 Start Mux'}
            </button>
          </div>

          {error && <div className="fm-error">{error}</div>}
        </div>
      )}

      {/* ── Muxing in progress ──────────────────────────────────────────── */}
      {(phase === 'mixing' || (phase === 'results' && activeTasks.length > 0)) && (
        <div className="mixer-section">
          <TaskList tasks={tasksData?.tasks ?? []} />

          <div className="mixer-actions">
            <button className="action-btn" onClick={resetAll}>
              ← New Mux
            </button>
          </div>
        </div>
      )}

      {/* ── Background task list (always visible when there are tasks) ──── */}
      {phase === 'idle' && tasksData && tasksData.tasks.length > 0 && (
        <div className="mixer-section">
          <TaskList tasks={tasksData.tasks} />
        </div>
      )}
    </section>
  )
}
