# Media Mux Specification

## Purpose

Merge selected audio tracks from one or two source files into a new output file using ffmpeg stream copy (no re-encode). Supports background task execution with progress tracking and cancellation.

## Requirements

### Requirement: FR-006 — Start Mux Task

The system SHALL accept a mux request specifying the video source, selected audio sources, and output path, then start a background task that runs ffmpeg with stream copy.

#### Scenario: Mux with one video and one audio track

- GIVEN the user has probed two files and selected video track index 0 from file A and audio track index 1 from file A
- WHEN the user calls `POST /api/mixer/mux` with the selected tracks
- THEN the system SHALL return HTTP 200 with `{"ok": true, "task_id": "<uuid>"}`
- AND a background task SHALL be created with status `"running"`
- AND ffmpeg SHALL be invoked with `-map 0:v:0 -map 0:a:1 -c copy` flags

#### Scenario: Mux with video from file A and audio from file B

- GIVEN the user selected video track 0 from file A and audio track 2 from file B
- WHEN the user calls mux
- THEN ffmpeg SHALL receive `-i <fileA> -i <fileB> -map 0:v:0 -map 1:a:2 -c copy`
- AND the output file SHALL be written to the configured output directory

#### Scenario: Mux with multiple audio tracks

- GIVEN the user selected video track 0 from file A, audio track 1 from file A, and audio track 2 from file B
- WHEN the user calls mux
- THEN ffmpeg SHALL map both audio tracks to the output
- AND the output file SHALL contain the video track and both audio tracks

#### Scenario: Mux with no audio tracks selected

- WHEN the user calls mux with an empty `audio_tracks` array
- THEN the response SHALL return HTTP 400
- AND the body SHALL contain `{"ok": false, "detail": "At least one audio track must be selected"}`

#### Scenario: Mux request with missing required fields

- WHEN the user calls mux without `video_source` field
- THEN the response SHALL return HTTP 400
- AND the body SHALL contain `{"ok": false, "detail": "video_source is required"}`

#### Scenario: Mux when ffmpeg is not installed

- GIVEN the system does not have ffmpeg available in PATH
- WHEN the user calls mux
- THEN the response SHALL return HTTP 500
- AND the body SHALL contain `{"ok": false, "detail": "ffmpeg not found"}`

### Requirement: FR-007 — Output File Naming

The system SHALL name the output file using the pattern `{original_name}_{timestamp}_mixed.{ext}` where `original_name` is the stem of the video source file, `timestamp` is ISO 8601 basic format (YYYYMMDDTHHmmss), and `ext` is the original file extension.

#### Scenario: Output naming for a mkv file

- GIVEN the video source file is `/mnt/storage/movies/Inception.mkv`
- WHEN the mux task starts at 2026-09-20T14:30:00
- THEN the output file SHALL be named `Inception_20260920T143000_mixed.mkv`
- AND the output file SHALL be placed in the directory configured as `paths.output_mixed`

#### Scenario: Output naming for an mp4 file

- GIVEN the video source file is `/mnt/storage/movies/Tenet.mp4`
- WHEN the mux task starts
- THEN the output file extension SHALL be `.mp4`

#### Scenario: Output directory does not exist

- GIVEN the configured `paths.output_mixed` directory does not exist
- WHEN the mux task starts
- THEN the system SHALL create the output directory before writing

### Requirement: FR-008 — Task Progress Tracking

The system SHALL track mux task progress and make it available via polling.

#### Scenario: Poll a running task

- GIVEN a mux task is in progress with task_id "abc-123"
- WHEN the user calls `GET /api/mixer/tasks/abc-123`
- THEN the response SHALL contain `{"status": "running", "progress": <float 0-1>, "detail": "..."}`
- AND `progress` SHALL represent the fraction of the mux operation completed (estimated from ffmpeg output)

#### Scenario: Poll a completed task

- GIVEN a mux task has finished successfully
- WHEN the user polls the task
- THEN the response SHALL contain `{"status": "done", "progress": 1.0, "output_path": "...", "detail": "Mux complete"}`
- AND `output_path` SHALL be the absolute path to the output file

#### Scenario: Poll a failed task

- GIVEN a mux task has failed
- WHEN the user polls the task
- THEN the response SHALL contain `{"status": "error", "detail": "<error message>"}`
- AND the partial output file SHALL be cleaned up (deleted)

#### Scenario: Poll a non-existent task

- GIVEN no task exists with task_id "unknown-id"
- WHEN the user polls that task
- THEN the response SHALL return HTTP 404
- AND the body SHALL contain `{"ok": false, "detail": "Task not found"}`

#### Scenario: Task TTL expiry

- GIVEN a task completed more than 600 seconds ago
- WHEN the user polls the task
- THEN the response SHALL return HTTP 404
- AND the task SHALL be removed from memory

### Requirement: FR-009 — Cancel Mux Task

The system SHALL support cancelling a running mux task, stopping ffmpeg and cleaning up partial output.

#### Scenario: Cancel a running task

- GIVEN a mux task "abc-123" is in `"running"` status
- WHEN the user calls `POST /api/mixer/tasks/abc-123/cancel`
- THEN the response SHALL return `{"ok": true, "detail": "Task cancelled"}`
- AND the ffmpeg process SHALL be terminated
- AND the task status SHALL become `"cancelled"`
- AND any partial output file SHALL be deleted

#### Scenario: Cancel an already-completed task

- GIVEN a mux task has status `"done"`
- WHEN the user calls cancel
- THEN the response SHALL return HTTP 400
- AND the body SHALL contain `{"ok": false, "detail": "Task is not running"}`

#### Scenario: Cancel a non-existent task

- WHEN the user calls cancel on a non-existent task_id
- THEN the response SHALL return HTTP 404

### Requirement: FR-010 — Stream Copy Preservation

The mux operation SHALL use ffmpeg stream copy mode (`-c copy`) for all tracks, preserving original quality without re-encoding.

#### Scenario: Output file preserves video quality

- GIVEN a source video track encoded in HEVC at 5000kbps
- WHEN the mux completes
- THEN the output file's video track SHALL have the same codec and bitrate as the source
- AND no re-encoding SHALL occur

#### Scenario: Output file preserves audio quality

- GIVEN a source audio track encoded in AAC at 192kbps
- WHEN the mux completes
- THEN the output file's audio track SHALL have the same codec, channels, and bitrate as the source

### Requirement: FR-011 — Background Execution

The mux operation SHALL run as a background task using `asyncio.to_thread` to avoid blocking the FastAPI event loop.

#### Scenario: API returns immediately while mux runs

- WHEN the user calls `POST /api/mixer/mux`
- THEN the response SHALL be returned within 1 second
- AND the mux operation SHALL continue running in the background
- AND the user SHALL be able to poll progress via the task endpoint

#### Scenario: Concurrent mux tasks

- GIVEN one mux task is already running
- WHEN the user starts a second mux task
- THEN both tasks SHALL run concurrently
- AND each SHALL have independent progress tracking

### Requirement: FR-012 — Cancelled Task Cleanup

When a mux task is cancelled, the system SHALL clean up the ffmpeg process and any partial output files.

#### Scenario: Partial file removed on cancel

- GIVEN a mux task is running and has written a partial output file
- WHEN the user cancels the task
- THEN the partial output file SHALL be deleted from disk
- AND the task status SHALL be `"cancelled"`

## Data Models

### Mux Request

```json
{
  "video_source": {
    "path": "/mnt/storage/movies/fileA.mkv",
    "track_index": 0
  },
  "audio_sources": [
    {
      "path": "/mnt/storage/movies/fileA.mkv",
      "track_index": 1
    },
    {
      "path": "/mnt/storage/movies/fileB.mkv",
      "track_index": 2
    }
  ]
}
```

### Task Status

```json
{
  "task_id": "abc-123-def-456",
  "status": "running",
  "progress": 0.45,
  "detail": "Muxing... 45%",
  "output_path": null,
  "created_at": 1695216600.0
}
```

**Status values:** `"running"` | `"done"` | `"error"` | `"cancelled"`

### Mux Start Response

```json
{
  "ok": true,
  "task_id": "abc-123-def-456"
}
```

### Cancel Response

```json
{
  "ok": true,
  "detail": "Task cancelled"
}
```

## API Contracts

### POST /api/mixer/mux

**Request:**

```json
{
  "video_source": { "path": "/path/to/file.mkv", "track_index": 0 },
  "audio_sources": [
    { "path": "/path/to/file.mkv", "track_index": 1 }
  ]
}
```

**Response (200):**

```json
{ "ok": true, "task_id": "abc-123" }
```

**Response (400):**

```json
{ "ok": false, "detail": "At least one audio track must be selected" }
```

**Response (500):**

```json
{ "ok": false, "detail": "ffmpeg not found" }
```

**Authentication:** Requires valid API key via `X-API-Key` header.

### GET /api/mixer/tasks/{task_id}

**Response (200):**

```json
{
  "task_id": "abc-123",
  "status": "running",
  "progress": 0.45,
  "detail": "Muxing...",
  "output_path": null,
  "created_at": 1695216600.0
}
```

**Response (404):**

```json
{ "ok": false, "detail": "Task not found" }
```

**Authentication:** Requires valid API key via `X-API-Key` header.

### POST /api/mixer/tasks/{task_id}/cancel

**Response (200):**

```json
{ "ok": true, "detail": "Task cancelled" }
```

**Response (400):**

```json
{ "ok": false, "detail": "Task is not running" }
```

**Response (404):**

```json
{ "ok": false, "detail": "Task not found" }
```

**Authentication:** Requires valid API key via `X-API-Key` header.

## Error Handling

| Condition | HTTP Status | Detail Message |
|-----------|-------------|----------------|
| ffmpeg not found | 500 | "ffmpeg not found" |
| Invalid input file | 400 | "Invalid input: <ffprobe error>" |
| No audio tracks selected | 400 | "At least one audio track must be selected" |
| Output directory not writable | 500 | "Cannot write to output directory: <path>" |
| ffmpeg process fails | 500 | "Mux failed: <stderr excerpt>" |
| Disk space exhausted | 500 | "Insufficient disk space" |
| Task not found | 404 | "Task not found" |
| Cancel non-running task | 400 | "Task is not running" |
