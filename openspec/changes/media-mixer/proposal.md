# Proposal: Media Mixer

## Intent

Users frequently download multiple versions of the same film (theatrical, extended, director's cut) from different sources, each with different audio track configurations. Currently there's no way to combine the best video track from one file with preferred audio tracks from another without external tools like MKVToolNix or handbrake. This feature brings that capability directly into the flow-controller dashboard, letting users merge audio tracks between two video files using stream copy (no re-encode), preserving original quality while customizing their audio setup.

## Scope

### In Scope
- Probe two video files for video/audio track metadata (codec, channels, language, bitrate)
- Auto-select best video track by compression quality (x265 > x264 > rest)
- Present audio track selection UI with checkboxes for both files
- Check compatibility between files (FPS, resolution, duration mismatch warnings)
- Mux selected audio tracks into output using stream copy
- Background task tracking with progress and cancellation
- Output to configurable directory with naming convention: `{original_name}_{timestamp}_mixed.{ext}`
- Settings integration: add `paths.output_mixed` to settings.json

### Out of Scope
- Video re-encoding or filtering
- Subtitle track handling (future enhancement)
- Audio track re-encoding or codec conversion
- Batch processing (single pair only for now)
- Preview/playback of output before muxing

## Capabilities

### New Capabilities
- `media-probe`: Analyze video files for track metadata (video codec, audio tracks, compatibility checks)
- `media-mux`: Merge selected audio tracks into output file using stream copy
- `media-mixer-ui`: Frontend component for file selection, track selection, and progress display

### Modified Capabilities
None — this is entirely new functionality.

## Approach

### Backend: `backend/media_mixer.py`

New module following `copy_engine.py` patterns:
- `_tasks` dict for async task tracking with progress/cancellation
- `probe_file(path)` → runs `ffprobe -print_format json -show_streams` via `subprocess.run`
- `check_compatibility(file_a, file_b)` → compares FPS, resolution, duration
- `select_best_video(streams)` → returns highest quality video track (x265 > x264 > rest)
- `mux_audio(video_source, audio_sources, output_path, task_id)` → runs `ffmpeg -i ... -map ... -c copy` via `subprocess.run`
- All ffmpeg calls use `asyncio.to_thread` to avoid blocking the event loop
- Task dict structure mirrors `copy_engine.py`: `{status, created_at, progress, detail, cancelled}`

### API Routes (added to `backend/app.py`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/mixer/probe` | POST | Probe two files, return track metadata + compatibility |
| `/api/mixer/mux` | POST | Start mux task with selected tracks |
| `/api/mixer/tasks/{task_id}` | GET | Poll task progress/status |
| `/api/mixer/tasks/{task_id}/cancel` | POST | Cancel running task |

### Frontend: `frontend/src/components/MediaMixer.tsx`

User flow:
1. Select two video files from file browser (reuse existing FileManager patterns)
2. Click "Analyze" → calls `/api/mixer/probe`
3. Display results: video tracks with auto-selection, audio tracks with checkboxes
4. Show compatibility warnings (FPS mismatch, duration difference > 5%)
5. User selects audio tracks and order
6. Click "Mix" → calls `/api/mixer/mux` with selected tracks
7. Progress bar with cancel button
8. Done → show output file path

### Settings Integration

Add to `settings.py` DEFAULTS:
```python
"paths": {
    ...
    "output_mixed": "/mnt/storage/mixed",
}
```

Add env var mapping: `FOLDER_OUTPUT_MIXED` → `("paths", "output_mixed")`

### Dockerfile Changes

Add to runtime stage:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
```

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `backend/media_mixer.py` | New | ffprobe/ffmpeg wrapper module with task tracking |
| `backend/app.py` | Modified | Add 4 new API routes under `/api/mixer/` |
| `backend/settings.py` | Modified | Add `output_mixed` path default and env mapping |
| `frontend/src/components/MediaMixer.tsx` | New | UI component for file selection and track mixing |
| `frontend/src/components/Sidebar.tsx` | Modified | Add "Media Mixer" nav entry |
| `frontend/src/App.tsx` | Modified | Add route for MediaMixer page |
| `Dockerfile` | Modified | Install ffmpeg package |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| ffmpeg binary not available in production | High | Add to Dockerfile, document manual install for local dev |
| Large files cause OOM during probe | Low | ffprobe is lightweight; mux uses stream copy (no decode) |
| Cross-version merging produces sync issues | Medium | Compatibility check warns on FPS/duration mismatch; user confirms |
| No existing subprocess patterns in codebase | Low | Follow asyncio.to_thread pattern from copy_engine.py |
| Disk space for output files | Medium | Output goes to configurable directory; show file size in results |

## Rollback Plan

1. Remove new files: `backend/media_mixer.py`, `frontend/src/components/MediaMixer.tsx`
2. Revert changes to: `app.py`, `settings.py`, `Sidebar.tsx`, `App.tsx`, `Dockerfile`
3. Remove ffmpeg from Dockerfile: `apt-get remove ffmpeg`
4. No database migrations to rollback (all in-memory/file-based)

## Dependencies

- ffmpeg/ffprobe binaries must be installed (Dockerfile change)
- No external Python packages required (raw subprocess calls)
- Can be developed independently of other features

## Success Criteria

- [ ] Probe endpoint returns correct video/audio track metadata for any valid video file
- [ ] Compatibility check correctly identifies FPS and duration mismatches
- [ ] Video track auto-selection picks x265 over x264 over other codecs
- [ ] Mux operation produces valid output file with selected audio tracks
- [ ] Stream copy preserves original quality (no re-encode)
- [ ] Task progress updates in real-time during mux operation
- [ ] Cancel button stops mux operation and cleans up partial files
- [ ] Output file follows naming convention: `{name}_{timestamp}_mixed.{ext}`
- [ ] Settings integration: `paths.output_mixed` configurable via settings.json
- [ ] Docker image includes ffmpeg and works in production
