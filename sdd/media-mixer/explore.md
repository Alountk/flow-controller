# Exploration: Media Mixer

## Current State

The flow-controller project is a media pipeline monitoring dashboard (Radarr → aMuTorrent → Sonarr). Backend: FastAPI (single `app.py` with ~1450 lines, routes, task queue), `copy_engine.py` (file copy/move with async task tracking), `clients.py` (external service integrations), `traces.py`, `settings.py`. Frontend: React 19 + TypeScript + Vite 7 + @tanstack/react-query, component-based with pages (dashboard, trace, wanted, calendar, disk, files, config, prototypes).

**No existing media processing code** — zero matches for ffmpeg/ffprobe/subprocess/shutil.which in the entire codebase. The Dockerfile uses `python:3.11-slim` without ffmpeg.

## Affected Areas

- `backend/app.py` — needs new API routes for probe/mux operations
- `backend/copy_engine.py` — pattern for async task tracking with progress/cancellation can be reused
- `frontend/src/components/Sidebar.tsx` — needs new "Media Mixer" nav entry
- `frontend/src/App.tsx` — needs new page route
- New file: `backend/media_mixer.py` — ffmpeg/ffprobe wrapper module
- New file: `frontend/src/components/MediaMixer.tsx` — UI component
- `backend/Dockerfile` — must install ffmpeg/ffprobe
- `backend/requirements.txt` — add ffmpeg-python or subprocess usage

## External Tool Requirements

- **ffprobe**: Probe video (codec, resolution, FPS, duration) and audio tracks (codec, channels, bitrate, language)
- **ffmpeg**: Mux selected audio tracks into output file
- **Python wrapper options**: ffmpeg-python (139 snippets, score 82.57), typed-ffmpeg (2087 snippets, score 91), or raw subprocess calls

## Recommended Library: `ffmpeg-python`

- Mature, well-documented, wraps ffprobe/ffmpeg directly
- Can build complex filter graphs for multi-audio-track muxing
- Lighter dependency than typed-ffmpeg (which is overkill for probe+mux)

## Integration Strategy

- New `backend/media_mixer.py` module following copy_engine patterns (async task tracking, progress dict, cancellation)
- New API routes: `POST /api/mixer/probe` (analyze files), `POST /api/mixer/mux` (execute merge), `GET /api/mixer/tasks/{id}` (progress)
- Frontend: new "Media Mixer" page with dual-file picker, probe results display, audio track checkboxes, progress indicator
- Output files stored in configurable output directory (add to settings)

## Key Technical Decisions Needed

1. How to handle ffmpeg binary availability (Dockerfile modification required)
2. Output file naming convention (timestamp? user-provided?)
3. Whether to support remuxing vs full re-encode
4. Compatibility warning strategy (different FPS, duration mismatch)

## Risks

- Large file processing can be slow (mitigation: background tasks with progress)
- ffmpeg binary not in slim Docker image (must install in Dockerfile)
- Cross-version video merging (extended vs theatrical) may produce sync issues
- Disk space requirements for temp files during muxing
- No existing subprocess patterns in codebase — first usage

## Ready for Proposal

Yes — sufficient architecture understanding to proceed. Needs user input on: output directory location, naming convention, and whether to support re-encoding or only stream copying.
