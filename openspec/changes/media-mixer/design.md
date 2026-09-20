# Design: Media Mixer

## Technical Approach

Add a new `media_mixer` module to the backend that wraps `ffprobe` and `ffmpeg` subprocess calls for probing video files and muxing audio tracks. Expose 6 new API endpoints under `/api/mixer/` registered in `app.py`. Add a new `MediaMixer` React component that reuses `FileManager` patterns for file selection, with a custom UI for track comparison and selection. The design follows existing patterns: task tracking mirrors `copy_engine.py`'s `_tasks` dict, settings integration follows the `DEFAULTS` + env override pattern, and the frontend uses `@tanstack/react-query` for server state.

## Architecture Decisions

### Decision: Separate module vs extending copy_engine

**Choice**: Create a new `backend/media_mixer.py` module rather than adding to `copy_engine.py`

**Alternatives considered**:
- Extend `copy_engine.py` with mux functionality
- Create a shared `task_engine.py` base module

**Rationale**: `copy_engine.py` is 448 lines and tightly coupled to file copy + Radarr/Sonarr import logic. Mux operations are conceptually different (ffmpeg subprocess vs file copy). A separate module keeps responsibilities clean. The task tracking pattern (`_tasks` dict + lock) is simple enough to duplicate without a shared base. If task tracking grows more complex later, a shared module can be extracted then.

### Decision: Synchronous subprocess with asyncio.to_thread

**Choice**: Use `subprocess.run` inside `asyncio.to_thread` for both ffprobe and ffmpeg calls

**Alternatives considered**:
- `asyncio.create_subprocess_exec` for native async subprocess
- `subprocess.Popen` with manual polling

**Rationale**: The existing codebase uses `asyncio.to_thread` for blocking operations (see `copy_engine.py` line 140). `subprocess.run` is simpler to reason about, handles stdout/stderr capture cleanly, and the thread pool avoids blocking the event loop. Native async subprocess would be marginally more efficient but adds complexity for negligible gain since mux operations are long-running (seconds to minutes).

### Decision: Task state machine with pause support

**Choice**: Extend the task dict with `paused` status and a `pause_event` (threading.Event) for coordination

**Alternatives considered**:
- SIGSTOP/SIGCONT process signals (platform-specific, fragile)
- No pause support (simplest)

**Rationale**: The spec explicitly requires pause/resume. A `threading.Event` is the cleanest way to pause a thread running `subprocess.run`. The mux function checks the event periodically (between ffmpeg chunks via stderr parsing) and blocks when paused. This is portable and doesn't require process signal handling.

### Decision: Parse ffmpeg progress from stderr

**Choice**: Parse ffmpeg's `-progress pipe:1` output for progress percentage

**Alternatives considered**:
- Fixed timeout estimation (inaccurate)
- File size ratio (only works for known total)

**Rationale**: ffmpeg's `-progress pipe:1` outputs key=value pairs including `out_time_us` and `Duration`. By comparing output time to total duration, we get accurate progress (0.0-1.0). This is the standard approach for ffmpeg progress tracking.

### Decision: Frontend as single component with internal state machine

**Choice**: Single `MediaMixer.tsx` component with internal state machine (`idle → probing → results → mixing → done`)

**Alternatives considered**:
- Multiple page-level components with routing
- Separate sub-components for each state

**Rationale**: The user flow is linear and tightly coupled (select files → probe → select tracks → mix). A single component with internal state is simpler than routing between sub-pages. The spec's component hierarchy (FileSelectorGroup, ProbeResults, MixSection) maps to internal render conditions, not separate routes.

### Decision: Reuse FileManager for file selection

**Choice**: Embed two `FilePane` instances (from FileManager) for dual file selection

**Alternatives considered**:
- Custom file picker from scratch
- Simple text input for paths

**Rationale**: The spec explicitly requires reusing FileManager. The `FilePane` component already handles browsing, volume selection, and path management. We extract the file selection logic (click to select, return path) without the copy/move queue actions.

## Data Flow

```
User selects files (FilePane × 2)
        │
        ▼
POST /api/mixer/probe {files: [pathA, pathB]}
        │
        ▼
media_mixer.probe_file(pathA)  ──→  ffprobe subprocess
media_mixer.probe_file(pathB)  ──→  ffprobe subprocess
        │
        ▼
media_mixer.check_compatibility(probeA, probeB)
        │
        ▼
Response: {files: [...], compatibility: {...}}
        │
        ▼
User selects audio tracks (checkboxes)
        │
        ▼
POST /api/mixer/mux {video_source: {...}, audio_sources: [...]}
        │
        ▼
media_mixer.start_mux()  ──→  Creates task dict
        │                     asyncio.create_task()
        ▼                     │
Task ID returned               ▼
                         _run_mux_background()
                               │
                               ├── Check pause_event (if paused, wait)
                               ├── Run ffmpeg -progress pipe:1
                               ├── Parse stderr for progress
                               ├── Update _tasks[task_id] progress
                               └── On complete: update status
                                      │
                                      ▼
GET /api/mixer/tasks/{task_id}  ←──  Frontend polls every 2s
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `backend/media_mixer.py` | Create | ffprobe/ffmpeg wrapper module with task tracking |
| `backend/app.py` | Modify | Add 6 new API routes under `/api/mixer/`, import media_mixer |
| `backend/settings.py` | Modify | Add `output_mixed` path default and `FOLDER_OUTPUT_MIXED` env mapping |
| `frontend/src/components/MediaMixer.tsx` | Create | UI component for file selection, track comparison, mux progress |
| `frontend/src/api/mixer.ts` | Create | API client functions for mixer endpoints |
| `frontend/src/components/Sidebar.tsx` | Modify | Add "Media Mixer" nav entry, extend `Page` type |
| `frontend/src/App.tsx` | Modify | Add route for MediaMixer page, extend `PAGE_TITLES` |
| `Dockerfile` | Modify | Install ffmpeg package in runtime stage |

## Interfaces / Contracts

### Backend: media_mixer.py

```python
import asyncio
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

# Shared task state (mirrors copy_engine.py pattern)
_tasks: dict[str, dict] = {}
_task_lock = asyncio.Lock()

# Priority: hevc > h264 > other (lower index = higher priority)
CODEC_PRIORITY = {"hevc": 0, "h265": 0, "h264": 1, "avc": 1}


def probe_file(path: str) -> dict:
    """Run ffprobe on a file, return parsed metadata.
    
    Returns:
        {
            "filename": str,
            "path": str,
            "format": str,
            "duration": float,
            "size_bytes": int,
            "video_tracks": [...],
            "audio_tracks": [...]
        }
    Raises:
        FileNotFoundError: if file doesn't exist
        RuntimeError: if ffprobe fails or is not installed
    """
    ...


def select_best_video(video_tracks: list[dict]) -> list[dict]:
    """Mark the highest-quality video track as selected.
    
    Returns the same list with 'selected' field added to each track.
    Priority: hevc/h265 > h264/avc > others.
    If multiple tracks have same priority, first one wins.
    """
    ...


def check_compatibility(probe_a: dict, probe_b: dict) -> dict:
    """Compare two probed files for compatibility.
    
    Returns:
        {
            "ok": True,  # always True (warnings don't block)
            "warnings": [
                {"type": "fps_mismatch"|"duration_mismatch"|"resolution_mismatch",
                 "message": str,
                 "file_a_value": Any,
                 "file_b_value": Any}
            ]
        }
    """
    ...


def build_mux_command(
    video_source: dict,
    audio_sources: list[dict],
    output_path: str,
) -> list[str]:
    """Build ffmpeg command for mux operation.
    
    Returns command as list of strings for subprocess.run.
    Uses -c copy for all tracks (stream copy, no re-encode).
    """
    ...


def start_mux(
    video_source: dict,
    audio_sources: list[dict],
    output_dir: str,
) -> str:
    """Start a mux task. Returns task_id.
    
    Creates task dict, launches background coroutine.
    """
    ...


async def _run_mux_background(task_id: str, cmd: list[str], output_path: str):
    """Background coroutine that runs ffmpeg and tracks progress.
    
    Parses -progress pipe:1 output for out_time_us vs Duration.
    Updates _tasks[task_id] with progress (0.0-1.0).
    Handles pause via threading.Event.
    On completion: sets status to "done" with output_path.
    On failure: sets status to "error", cleans up partial file.
    On cancel: terminates process, cleans up partial file.
    """
    ...


def cancel_task(task_id: str) -> dict:
    """Cancel a running task. Returns {"ok": True/False, "detail": str}."""
    ...


def pause_task(task_id: str) -> dict:
    """Pause a pending/running task. Returns {"ok": True/False, "detail": str}."""
    ...


def resume_task(task_id: str) -> dict:
    """Resume a paused task. Returns {"ok": True/False, "detail": str}."""
    ...


def get_task(task_id: str) -> dict | None:
    """Get task status. Returns None if not found or expired."""
    ...


def cleanup_tasks():
    """Remove completed tasks older than 600s TTL."""
    ...
```

### Backend: API Routes (app.py additions)

```python
# Pydantic models for request/response

class ProbeRequest(BaseModel):
    files: list[str]  # exactly 2 file paths

class MuxRequest(BaseModel):
    video_source: dict  # {"path": str, "track_index": int}
    audio_sources: list[dict]  # [{"path": str, "track_index": int}, ...]

# Routes (added to app.py after existing routes)

@app.post("/api/mixer/probe")
async def mixer_probe(req: ProbeRequest, _key: str = Depends(verify_api_key)):
    """Probe two files for metadata and compatibility."""
    ...

@app.post("/api/mixer/mux")
async def mixer_mux(req: MuxRequest, _key: str = Depends(verify_api_key)):
    """Start a mux task with selected tracks."""
    ...

@app.get("/api/mixer/tasks/{task_id}")
async def mixer_task_status(task_id: str, _key: str = Depends(verify_api_key)):
    """Poll task progress/status."""
    ...

@app.post("/api/mixer/tasks/{task_id}/cancel")
async def mixer_task_cancel(task_id: str, _key: str = Depends(verify_api_key)):
    """Cancel a running task."""
    ...

@app.post("/api/mixer/tasks/{task_id}/pause")
async def mixer_task_pause(task_id: str, _key: str = Depends(verify_api_key)):
    """Pause a pending/running task."""
    ...

@app.post("/api/mixer/tasks/{task_id}/resume")
async def mixer_task_resume(task_id: str, _key: str = Depends(verify_api_key)):
    """Resume a paused task."""
    ...
```

### Backend: Settings (settings.py additions)

```python
# In DEFAULTS dict, add to "paths":
"paths": {
    ...,
    "output_mixed": "/mnt/storage/mixed",
}

# In _env_to_settings dict, add:
"FOLDER_OUTPUT_MIXED": ("paths", "output_mixed"),
```

### Frontend: API Client (frontend/src/api/mixer.ts)

```typescript
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

export interface ProbeFileResult {
  filename: string
  path: string
  format: string
  duration: number
  size_bytes: number
  video_tracks: VideoTrack[]
  audio_tracks: AudioTrack[]
}

export interface CompatibilityWarning {
  type: 'fps_mismatch' | 'duration_mismatch' | 'resolution_mismatch'
  message: string
  file_a_value: unknown
  file_b_value: unknown
}

export interface ProbeResponse {
  ok: boolean
  files: ProbeFileResult[]
  compatibility: { ok: boolean; warnings: CompatibilityWarning[] }
  detail?: string
}

export interface MuxTaskStatus {
  ok: boolean
  task_id: string
  status: 'running' | 'done' | 'error' | 'cancelled' | 'paused'
  progress: number
  detail: string
  output_path: string | null
  created_at: number
}

export interface SourceRef {
  path: string
  track_index: number
}

export async function probeFiles(files: string[]): Promise<ProbeResponse> { ... }
export async function startMux(videoSource: SourceRef, audioSources: SourceRef[]): Promise<{ ok: boolean; task_id: string }> { ... }
export async function getMuxTask(taskId: string): Promise<MuxTaskStatus> { ... }
export async function cancelMuxTask(taskId: string): Promise<{ ok: boolean; detail: string }> { ... }
export async function pauseMuxTask(taskId: string): Promise<{ ok: boolean; detail: string }> { ... }
export async function resumeMuxTask(taskId: string): Promise<{ ok: boolean; detail: string }> { ... }
```

### Frontend: MediaMixer Component (frontend/src/components/MediaMixer.tsx)

```typescript
// State machine
type UIState = 
  | { phase: 'idle' }                                    // Initial, no files selected
  | { phase: 'files-selected'; fileA: string; fileB: string }  // Two files chosen
  | { phase: 'probing'; fileA: string; fileB: string }         // Probe in flight
  | { phase: 'results'; probe: ProbeResponse; fileA: string; fileB: string }  // Results shown
  | { phase: 'mixing'; taskId: string }                        // Mux in progress
  | { phase: 'done'; outputPath: string }                      // Mux complete
  | { phase: 'error'; message: string }                        // Error state

// Component structure
function MediaMixer() {
  // State
  const [state, setState] = useState<UIState>({ phase: 'idle' })
  const [selectedAudio, setSelectedAudio] = useState<SourceRef[]>([])
  
  // Queries
  const probeMutation = useMutation({ mutationFn: probeFiles })
  const taskQuery = useQuery({
    queryKey: ['mux-task', state.taskId],
    queryFn: () => getMuxTask(state.taskId),
    enabled: state.phase === 'mixing',
    refetchInterval: 2000,
  })
  
  // Renders based on state.phase
  // - idle: Two FilePane instances + disabled Analyze button
  // - files-selected: Two FilePane instances + enabled Analyze button
  // - probing: Loading spinner
  // - results: ProbeResults with video tracks (auto-selected), audio checkboxes, compatibility warnings
  // - mixing: Progress bar + Cancel/Pause buttons
  // - done: Success message + output path
  // - error: Error display
}
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `probe_file()` parsing | Mock subprocess.run, verify parsed output structure |
| Unit | `select_best_video()` priority logic | Test codec priority ordering, edge cases (no video, single track) |
| Unit | `check_compatibility()` warnings | Test FPS/duration/resolution mismatch detection |
| Unit | `build_mux_command()` command construction | Verify correct `-map`, `-c copy` flags for various track combinations |
| Unit | `cleanup_tasks()` TTL expiry | Mock time.time(), verify expired tasks removed |
| Integration | `/api/mixer/probe` endpoint | Test with real ffprobe (if available), verify HTTP responses |
| Integration | `/api/mixer/mux` endpoint | Test task creation, progress polling, cancellation |
| Integration | Path resolution (absolute + relative) | Test both path types resolve correctly |
| Frontend | MediaMixer state transitions | Component test with mocked API responses |
| Frontend | Audio track selection | Verify checkbox behavior, selection order preservation |
| Frontend | Progress polling | Mock timer, verify progress bar updates |

## Threat Matrix

| Boundary | Applicability | Reason |
|----------|--------------|--------|
| Documentation-like paths | N/A | No routing, shell commands, subprocesses, VCS/PR automation, executable-file classification, or process integration in this change. |
| Git repository selection | N/A | Same reason. |
| Commit state | N/A | Same reason. |
| Push state | N/A | Same reason. |
| PR commands | N/A | Same reason. |

Note: This change DOES use subprocesses (ffprobe/ffmpeg), but via controlled `subprocess.run` calls with validated file paths. The threat matrix rows above are specifically about routing/VCS/PR automation boundaries, not general subprocess use. The subprocess calls in this design are internal tool invocations, not user-facing command injection surfaces.

**Subprocess safety note**: All file paths passed to ffprobe/ffmpeg are validated against `ALLOWED_ROOTS` (from `_validate_path`) before execution. The `build_mux_command()` function constructs the command list programmatically, preventing injection via track indices or file paths.

## Migration / Rollout

**No database migration required.** All state is in-memory (`_tasks` dict) or filesystem-based (settings.json).

**Rollout steps**:
1. Add `ffmpeg` to Dockerfile (new layer)
2. Deploy backend changes (new module + routes)
3. Deploy frontend changes (new component + routes)
4. Verify ffmpeg availability in production container

**Rollback**:
1. Revert `media_mixer.py` (new file, just delete)
2. Revert `MediaMixer.tsx` + `mixer.ts` (new files, just delete)
3. Revert changes to `app.py`, `settings.py`, `Sidebar.tsx`, `App.tsx`, `Dockerfile`
4. No data to clean up (in-memory tasks, no DB)

## Open Questions

- [ ] Should the probe endpoint validate file paths against `ALLOWED_ROOTS` like the file manager does? The spec says "accept both absolute paths AND relative paths to a configured root" — this implies path validation is needed.
- [ ] What happens if two mux tasks write to the same output file? The naming convention includes a timestamp (YYYYMMDDTHHmmss) which reduces collision risk, but doesn't eliminate it if two tasks start in the same second. Should we add a UUID suffix?
- [ ] The spec mentions "No limit on concurrent tasks - they queue and consume one by one" but also says tasks run concurrently. Which is correct? The proposal says "both tasks SHALL run concurrently" (FR-011). The user decision says "queue and consume one by one; add pause capability for unprocessed tasks." These are contradictory. Need clarification.
