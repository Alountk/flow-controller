# Tasks: Media Mixer

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 700-900 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (Backend Core) -> PR 2 (Backend API) -> PR 3 (Frontend) |
| Delivery strategy | auto-chain |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Backend core module + settings + Dockerfile | PR 1 | `pytest backend/tests.py -k mixer` | Real ffprobe/ffmpeg subprocess calls | `backend/media_mixer.py`, `backend/settings.py`, `Dockerfile` |
| 2 | Backend API routes | PR 2 | `pytest backend/tests.py -k mixer_api` | curl against running server | `backend/app.py` routes only |
| 3 | Frontend component + integration | PR 3 | `npm run test` in frontend | Browser navigation to /mixer | `frontend/src/components/MediaMixer.tsx`, `Sidebar.tsx`, `App.tsx` |

## Phase 1: Infrastructure

- [x] 1.1 Modify `backend/Dockerfile` -- add ffmpeg installation in runtime stage: `RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*`
- [x] 1.2 Modify `backend/settings.py` -- add `"output_mixed": "/mnt/storage/mixed"` to `DEFAULTS["paths"]` dict (line 21-25)
- [x] 1.3 Modify `backend/settings.py` -- add `"FOLDER_OUTPUT_MIXED": ("paths", "output_mixed")` to `_env_to_settings` dict (line 37-58)
- [x] 1.4 Create `backend/media_mixer.py` -- module skeleton with imports, `_tasks` dict, `_task_lock`, `CODEC_PRIORITY` constant, and all function stubs with docstrings

## Phase 2: Backend Core - Probe Functions

- [x] 2.1 Implement `probe_file(path: str) -> dict` in `backend/media_mixer.py` -- run `ffprobe -print_format json -show_streams -show_format` via `subprocess.run`, parse JSON output, return structured metadata (filename, path, format, duration, size_bytes, video_tracks, audio_tracks). Raise `FileNotFoundError` for missing files, `RuntimeError` for ffprobe failures.
- [x] 2.2 Implement `select_best_video(video_tracks: list[dict]) -> list[dict]` in `backend/media_mixer.py` -- add `selected` field to each track, mark highest priority as `true` (hevc/h265=0, h264/avc=1, others=2). First track wins ties.
- [x] 2.3 Implement `check_compatibility(probe_a: dict, probe_b: dict) -> dict` in `backend/media_mixer.py` -- compare FPS (threshold >0.001), resolution (any difference), duration (>5% difference). Return `{"ok": true, "warnings": [...]}` with typed warning objects.
- [x] 2.4 Write unit tests for probe functions in `backend/tests.py` -- test `probe_file` with mocked subprocess, `select_best_video` priority logic, `check_compatibility` warning generation. Use `unittest.mock.patch` for subprocess calls.

## Phase 3: Backend Core - Mux Functions

- [x] 3.1 Implement `build_mux_command(video_source, audio_sources, output_path) -> list[str]` in `backend/media_mixer.py` -- construct ffmpeg command with `-i` for each unique input file, `-map` for selected tracks, `-c copy` for stream copy, `-progress pipe:1` for progress output.
- [x] 3.2 Implement `start_mux(video_source, audio_sources, output_dir) -> str` in `backend/media_mixer.py` -- create task dict with status="running", progress=0.0, launch `_run_mux_background` via `asyncio.create_task`, return task_id.
- [x] 3.3 Implement `_run_mux_background(task_id, cmd, output_path)` in `backend/media_mixer.py` -- run ffmpeg via `asyncio.to_thread(subprocess.run, ...)`, parse `-progress pipe:1` stderr for `out_time_us` vs `Duration`, update `_tasks[task_id]["progress"]`. Handle pause via `threading.Event`. On completion: set status="done", output_path. On failure: set status="error", delete partial file. On cancel: terminate process, delete partial file.
- [x] 3.4 Implement `cancel_task(task_id) -> dict`, `pause_task(task_id) -> dict`, `resume_task(task_id) -> dict`, `get_task(task_id) -> dict | None`, `cleanup_tasks()` in `backend/media_mixer.py` -- cancel sets cancelled flag and terminates process; pause/resume use threading.Event; get_task returns task dict or None; cleanup removes expired tasks (>600s TTL).
- [x] 3.5 Write unit tests for mux functions in `backend/tests.py` -- test `build_mux_command` with various track combos, `start_mux` task creation, cancel/pause/resume state transitions, `cleanup_tasks` TTL expiry. Mock subprocess and time.time.

## Phase 4: Backend API Routes

- [ ] 4.1 Add Pydantic models to `backend/app.py` -- `ProbeRequest(files: list[str])`, `MuxRequest(video_source: dict, audio_sources: list[dict])` with validation.
- [ ] 4.2 Add `POST /api/mixer/probe` route to `backend/app.py` -- validate exactly 2 files, call `media_mixer.probe_file()` for each, call `check_compatibility()`, return structured response. Handle FileNotFoundError (400), RuntimeError (500).
- [ ] 4.3 Add `POST /api/mixer/mux` route to `backend/app.py` -- validate video_source and audio_sources present, call `media_mixer.start_mux()`, return task_id. Handle ffmpeg not found (500), invalid input (400).
- [ ] 4.4 Add `GET /api/mixer/tasks/{task_id}` route to `backend/app.py` -- call `media_mixer.get_task()`, return task status or 404.
- [ ] 4.5 Add `POST /api/mixer/tasks/{task_id}/cancel` route to `backend/app.py` -- call `media_mixer.cancel_task()`, return result or 404/400.
- [ ] 4.6 Add `POST /api/mixer/tasks/{task_id}/pause` route to `backend/app.py` -- call `media_mixer.pause_task()`, return result or 404/400.
- [ ] 4.7 Add `POST /api/mixer/tasks/{task_id}/resume` route to `backend/app.py` -- call `media_mixer.resume_task()`, return result or 404/400.
- [ ] 4.8 Add `import media_mixer` to `backend/app.py` top-level imports.
- [ ] 4.9 Write API integration tests in `backend/tests.py` -- test probe endpoint with valid/invalid files, mux endpoint task creation, task polling, cancel/pause/resume endpoints. Use FastAPI TestClient.

## Phase 5: Frontend - API Client

- [ ] 5.1 Create `frontend/src/api/mixer.ts` -- export TypeScript interfaces: `VideoTrack`, `AudioTrack`, `ProbeFileResult`, `CompatibilityWarning`, `ProbeResponse`, `MuxTaskStatus`, `SourceRef`.
- [ ] 5.2 Implement API functions in `frontend/src/api/mixer.ts` -- `probeFiles(files)`, `startMux(videoSource, audioSources)`, `getMuxTask(taskId)`, `cancelMuxTask(taskId)`, `pauseMuxTask(taskId)`, `resumeMuxTask(taskId)`. Use `fetchJson` pattern from App.tsx.

## Phase 6: Frontend - MediaMixer Component

- [ ] 6.1 Create `frontend/src/components/MediaMixer.tsx` -- component skeleton with `UIState` type union (`idle | files-selected | probing | results | mixing | done | error`), useState for state and selectedAudio, useMutation for probe, useQuery for task polling.
- [ ] 6.2 Implement idle/files-selected phase render in `MediaMixer.tsx` -- two FilePane instances for file selection, Analyze button (disabled until 2 files selected), clear/reset button. Wire file selection to state.
- [ ] 6.3 Implement probing phase render in `MediaMixer.tsx` -- loading spinner, disabled Analyze button, disabled file selectors during probe request.
- [ ] 6.4 Implement results phase render in `MediaMixer.tsx` -- display file metadata cards (filename, format, duration), video track list with auto-selected track highlighted, audio track checkboxes (default tracks pre-checked), compatibility warnings section with amber styling.
- [ ] 6.5 Implement mixing phase render in `MediaMixer.tsx` -- progress bar with role="progressbar", Cancel button, polling task endpoint every 2s via useQuery refetchInterval.
- [ ] 6.6 Implement done/error phases in `MediaMixer.tsx` -- success message with output path on done, error message with red progress bar on error, "Connection lost" message for network errors during polling.
- [ ] 6.7 Wire state transitions in `MediaMixer.tsx` -- clear probe results when file selection changes, disable Mix button when no audio tracks selected, preserve selection order in mux request.

## Phase 7: Frontend - Integration

- [ ] 7.1 Modify `frontend/src/components/Sidebar.tsx` -- extend `Page` type to include `'mixer'`, add `mixer: '/mixer'` to `PAGE_PATHS`, add nav item `{ key: 'mixer', label: 'Media Mixer', icon: '🎬' }` to `NAV_ITEMS`.
- [ ] 7.2 Modify `frontend/src/App.tsx` -- add `import { MediaMixer } from './components/MediaMixer'`, add `mixer: 'Media Mixer'` to `PAGE_TITLES`, add route condition `page === 'mixer' && <MediaMixer />` in render.

## Phase 8: Verification

- [ ] 8.1 Run `docker build -t flow-controller-test backend/` to verify Dockerfile builds with ffmpeg
- [ ] 8.2 Run `pytest backend/tests.py -v` to verify all backend tests pass
- [ ] 8.3 Start server manually and test probe endpoint with `curl -X POST http://localhost:8000/api/mixer/probe -H 'Content-Type: application/json' -d '{"files": ["test.mkv", "test2.mkv"]}'`
- [ ] 8.4 Start server and test mux workflow end-to-end: probe -> select tracks -> mix -> poll progress -> verify output file
- [ ] 8.5 Run `npm run build` in frontend to verify TypeScript compilation
- [ ] 8.6 Navigate to /mixer in browser and verify UI renders with file selection, analyze, and mix flow
