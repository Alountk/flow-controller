# Media Probe Specification

## Purpose

Analyze video files to extract track metadata (video codec, audio tracks, compatibility properties) using ffprobe. This enables the user to inspect and compare two files before muxing.

## Requirements

### Requirement: FR-001 — Probe File Metadata

The system SHALL accept a file path and return structured metadata for all video and audio streams using ffprobe.

#### Scenario: Probe a file with video and multiple audio tracks

- GIVEN a valid video file at `/mnt/storage/movies/movie.mkv` containing 1 video track and 3 audio tracks
- WHEN the user triggers probe via `POST /api/mixer/probe` with `{"files": ["/mnt/storage/movies/movie.mkv"]}`
- THEN the response SHALL contain a `files` array with one entry
- AND the entry SHALL include `filename`, `format` (container format string), and `duration` (float, seconds)
- AND the entry SHALL include a `video_tracks` array with one video track entry
- AND the entry SHALL include an `audio_tracks` array with three audio track entries
- AND each video track SHALL contain `index`, `codec` (e.g. "hevc", "h264"), `width`, `height`, `fps` (float), `bitrate` (integer, bps)
- AND each audio track SHALL contain `index`, `codec` (e.g. "aac", "ac3", "dts"), `language` (string, ISO 639-2), `channels` (integer), `bitrate` (integer, bps), `default` (boolean)

#### Scenario: Probe a file with only video and no audio

- GIVEN a valid video file containing 1 video track and 0 audio tracks
- WHEN the user triggers probe
- THEN the response SHALL contain `audio_tracks` as an empty array `[]`
- AND no error SHALL be returned

#### Scenario: Probe a non-existent file

- GIVEN no file exists at `/mnt/storage/movies/missing.mp4`
- WHEN the user triggers probe with that path
- THEN the response SHALL return HTTP 400
- AND the body SHALL contain `{"ok": false, "detail": "File not found: /mnt/storage/movies/missing.mp4"}`

#### Scenario: Probe a non-video file

- GIVEN a text file at `/mnt/storage/docs/readme.txt`
- WHEN the user triggers probe with that path
- THEN the response SHALL return HTTP 400
- AND the body SHALL contain `{"ok": false, "detail": ...}` with an error about invalid format

#### Scenario: Probe when ffprobe is not installed

- GIVEN the system does not have ffprobe available in PATH
- WHEN the user triggers probe
- THEN the response SHALL return HTTP 500
- AND the body SHALL contain `{"ok": false, "detail": "ffprobe not found"}`

### Requirement: FR-002 — Probe Two Files for Mux Comparison

The system SHALL accept exactly two file paths and return metadata for both in a single request, suitable for the media mixer comparison flow.

#### Scenario: Probe two valid files

- GIVEN two valid video files exist at paths A and B
- WHEN the user triggers `POST /api/mixer/probe` with `{"files": [pathA, pathB]}`
- THEN the response SHALL return `{"ok": true, "files": [probeA, probeB]}` with HTTP 200
- AND each probe entry SHALL follow the structure from FR-001

#### Scenario: Probe with one invalid file in a pair

- GIVEN file A is valid and file B does not exist
- WHEN the user triggers probe with both paths
- THEN the response SHALL return HTTP 400
- AND the error detail SHALL identify which file is invalid

#### Scenario: Probe with zero files

- WHEN the user triggers probe with `{"files": []}`
- THEN the response SHALL return HTTP 400
- AND the body SHALL contain `{"ok": false, "detail": "Exactly two files required"}`

#### Scenario: Probe with more than two files

- WHEN the user triggers probe with `{"files": ["a.mp4", "b.mp4", "c.mp4"]}`
- THEN the response SHALL return HTTP 400
- AND the body SHALL contain `{"ok": false, "detail": "Exactly two files required"}`

### Requirement: FR-003 — Auto-Select Best Video Track

The system SHALL automatically identify the highest-quality video track from each probed file using the priority order: x265 (HEVC) > x264 (AVC) > other codecs.

#### Scenario: File contains x265 and x264 tracks

- GIVEN a file contains one HEVC track at index 0 and one AVC track at index 2
- WHEN the probe response is returned
- THEN the HEVC track (index 0) SHALL be marked `"selected": true`
- AND the AVC track (index 2) SHALL be marked `"selected": false`

#### Scenario: File contains only one video track

- GIVEN a file contains one AVC track at index 0
- WHEN the probe response is returned
- THEN the single track SHALL be marked `"selected": true`

#### Scenario: File contains no video tracks

- GIVEN a file contains 0 video tracks
- WHEN the probe response is returned
- THEN `video_tracks` SHALL be an empty array
- AND no error SHALL be returned

### Requirement: FR-004 — Check Compatibility Between Two Files

The system SHALL compare FPS, resolution, and duration between two probed files and return compatibility warnings.

#### Scenario: Files are fully compatible

- GIVEN file A has fps=23.976, resolution=1920x1080, duration=7200s
- AND file B has fps=23.976, resolution=1920x1080, duration=7190s
- WHEN the probe response is returned
- THEN `compatibility` SHALL contain `"ok": true`
- AND `compatibility` SHALL contain an empty `warnings` array

#### Scenario: FPS mismatch exceeds threshold

- GIVEN file A has fps=23.976 and file B has fps=29.970
- WHEN the probe response is returned
- THEN `compatibility` SHALL contain a warning with `"type": "fps_mismatch"`
- AND the warning SHALL include both fps values
- AND `compatibility` SHALL still contain `"ok": true` (warning, not blocking)

#### Scenario: Duration mismatch exceeds 5%

- GIVEN file A has duration=7200s and file B has duration=6800s (5.5% difference)
- WHEN the probe response is returned
- THEN `compatibility` SHALL contain a warning with `"type": "duration_mismatch"`
- AND the warning SHALL include both duration values and the percentage difference

#### Scenario: Resolution mismatch

- GIVEN file A has resolution=1920x1080 and file B has resolution=3840x2160
- WHEN the probe response is returned
- THEN `compatibility` SHALL contain a warning with `"type": "resolution_mismatch"`
- AND the warning SHALL include both resolution values

#### Scenario: All mismatches present simultaneously

- GIVEN two files differ in FPS, resolution, AND duration
- WHEN the probe response is returned
- THEN `compatibility` SHALL contain three separate warning objects
- AND `compatibility` SHALL still contain `"ok": true` (all warnings, no blocks)

### Requirement: FR-005 — Compatibility Warning Structure

Each compatibility warning SHALL be a structured object with `type`, `message`, and relevant metric values.

#### Scenario: Warning object shape

- GIVEN compatibility checks produce a warning
- WHEN the probe response is returned
- THEN each warning SHALL contain `type` (string: "fps_mismatch" | "duration_mismatch" | "resolution_mismatch")
- AND each warning SHALL contain `message` (human-readable string)
- AND each warning SHALL contain `file_a_value` and `file_b_value` with the differing metric values

## Data Models

### Probe File Result

```json
{
  "filename": "movie.mkv",
  "path": "/mnt/storage/movies/movie.mkv",
  "format": "matroska,webm",
  "duration": 7200.0,
  "size_bytes": 10737418240,
  "video_tracks": [
    {
      "index": 0,
      "codec": "hevc",
      "width": 1920,
      "height": 1080,
      "fps": 23.976,
      "bitrate": 5000000,
      "selected": true
    }
  ],
  "audio_tracks": [
    {
      "index": 1,
      "codec": "aac",
      "language": "eng",
      "channels": 6,
      "bitrate": 192000,
      "default": true
    }
  ]
}
```

### Probe Response

```json
{
  "ok": true,
  "files": ["<Probe File Result>", "<Probe File Result>"],
  "compatibility": {
    "ok": true,
    "warnings": [
      {
        "type": "fps_mismatch",
        "message": "FPS differs: 23.976 vs 29.970",
        "file_a_value": 23.976,
        "file_b_value": 29.970
      }
    ]
  }
}
```

### Error Response

```json
{
  "ok": false,
  "detail": "File not found: /path/to/file"
}
```

## API Contract

### POST /api/mixer/probe

**Request:**

```json
{
  "files": ["/path/to/fileA.mkv", "/path/to/fileB.mkv"]
}
```

**Response (200):**

```json
{
  "ok": true,
  "files": ["<Probe File Result>", "<Probe File Result>"],
  "compatibility": {
    "ok": true,
    "warnings": []
  }
}
```

**Response (400):**

```json
{
  "ok": false,
  "detail": "Exactly two files required"
}
```

**Response (500):**

```json
{
  "ok": false,
  "detail": "ffprobe not found"
}
```

**Error Codes:**
- `400`: Invalid input (wrong file count, file not found, invalid format)
- `500`: System error (ffprobe not installed, unexpected ffprobe failure)

**Authentication:** Requires valid API key via `X-API-Key` header (same as existing routes).
