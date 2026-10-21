import asyncio
import json
import logging
import os
import subprocess
import threading
import time
import uuid
from collections import deque
from pathlib import Path

from task_manager import mux_tasks

log = logging.getLogger("flow-controller")

# S11-4: the serial mux queue — one ffmpeg mux at a time. `_mux_active` is the
# task owning the slot (running or paused); `_mux_queue` holds the `queued`
# task ids in FIFO order; `_pending_jobs` keeps each task's run payload until
# it settles (a resumed task relaunches from it).
_mux_lock = threading.Lock()
_mux_active: str | None = None
_mux_queue: deque[str] = deque()
_pending_jobs: dict[str, dict] = {}

# Priority: hevc > h264 > other (lower index = higher priority)
CODEC_PRIORITY: dict[str, int] = {"hevc": 0, "h265": 0, "h264": 1, "avc": 1}

#: S2: fixed display/selection order of audio languages — castellano,
#: inglés, ruso, catalán. The user's order; not configurable.
ORDERED_AUDIO_LANGUAGES: tuple[str, ...] = ("spa", "eng", "rus", "cat")

#: ISO 639-2/B + 639-1 aliases for the four ordered languages only.
_LANGUAGE_ALIASES: dict[str, str] = {
    "spa": "spa", "es": "spa",
    "eng": "eng", "en": "eng",
    "rus": "rus", "ru": "rus",
    "cat": "cat", "ca": "cat",
}

#: S6/L12: short sidecar suffixes for the four ordered languages (`…_mixed.es.srt`);
#: any other language uses its normalized code as the suffix.
SHORT_LANGUAGE_SUFFIXES: dict[str, str] = {"spa": "es", "eng": "en", "rus": "ru", "cat": "ca"}

#: S6: subtitle codecs ffmpeg can re-mux into `.srt` without OCR.
TEXT_SUBTITLE_CODECS: set[str] = {"subrip", "ssa", "ass", "webvtt", "mov_text", "text"}
#: S6/L12: bitmap subtitles (PGS/VobSub…) — «no extraíble» without OCR.
BITMAP_SUBTITLE_CODECS: set[str] = {"hdmv_pgs_subtitle", "pgssub", "dvd_subtitle", "dvb_subtitle"}


def _subtitle_kind(codec: str) -> str:
    """`text` (→ .srt possible), `bitmap` (needs OCR) or `unknown`."""
    if codec in TEXT_SUBTITLE_CODECS:
        return "text"
    if codec in BITMAP_SUBTITLE_CODECS:
        return "bitmap"
    return "unknown"


def normalize_language(tag: str) -> str:
    """Canonical three-letter code for an audio language tag (S2).

    ffprobe reports ISO 639-2 (`spa/eng/rus/cat`) but short codes (`es/en/ru/ca`)
    appear too. Only the four ordered languages get a canonical mapping;
    anything else passes through lowercased (`fra -> fra`, `fr -> fr`).
    """
    cleaned = str(tag or "").strip().lower()
    return _LANGUAGE_ALIASES.get(cleaned, cleaned)


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
            "audio_tracks": [...],
            "subtitle_tracks": [...]
        }
    Raises:
        FileNotFoundError: if file doesn't exist
        RuntimeError: if ffprobe fails or is not installed
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"File not found: {path}")

    cmd = [
        "ffprobe",
        "-print_format", "json",
        "-show_streams",
        "-show_format",
        path,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        raise RuntimeError("ffprobe not found")
    except subprocess.TimeoutExpired:
        raise RuntimeError("ffprobe timed out")

    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr[:200]}")

    data = json.loads(result.stdout)
    return parse_probe_data(data, path)


def parse_probe_data(data: dict, path: str) -> dict:
    """Parse ffprobe JSON into typed dict."""
    p = Path(path)
    fmt = data.get("format", {})
    streams = data.get("streams", [])

    video_tracks = []
    audio_tracks = []
    subtitle_tracks = []
    ordinals = {"video": 0, "audio": 0, "subtitle": 0}

    for s in streams:
        codec_type = s.get("codec_type")
        if codec_type not in ordinals:
            continue
        # Ordinal within its codec_type — the value ffmpeg -map v:N/a:N/s:N
        # expects (L18: MuxRequest.track_index contract). `index` stays the
        # absolute ffprobe stream index.
        track_index = ordinals[codec_type]
        ordinals[codec_type] += 1

        if codec_type == "video":
            fps_str = s.get("r_frame_rate", "0/1")
            try:
                num, den = fps_str.split("/")
                fps = float(num) / float(den) if float(den) != 0 else 0.0
            except (ValueError, ZeroDivisionError):
                fps = 0.0

            video_tracks.append({
                "index": s.get("index", 0),
                "track_index": track_index,
                "codec": s.get("codec_name", "unknown"),
                "width": s.get("width", 0),
                "height": s.get("height", 0),
                "fps": round(fps, 3),
                "bitrate": int(s.get("bit_rate", 0) or 0),
                "selected": False,
            })
        elif codec_type == "audio":
            tags = s.get("tags", {})
            language = tags.get("language", "und")
            default = tags.get("DEFAULT", "no") == "yes" or s.get("disposition", {}).get("default", 0) == 1

            audio_tracks.append({
                "index": s.get("index", 0),
                "track_index": track_index,
                "codec": s.get("codec_name", "unknown"),
                "language": language,
                "channels": s.get("channels", 0),
                "bitrate": int(s.get("bit_rate", 0) or 0),
                "default": default,
            })
        else:  # subtitle (S6)
            tags = s.get("tags", {})
            disposition = s.get("disposition", {})
            language = tags.get("language", "und")
            codec = s.get("codec_name", "unknown")
            kind = _subtitle_kind(codec)

            subtitle_tracks.append({
                "index": s.get("index", 0),
                "track_index": track_index,
                "codec": codec,
                "language": language,
                "language_code": normalize_language(language),
                "title": tags.get("title", ""),
                "forced": disposition.get("forced", 0) == 1,
                "default": disposition.get("default", 0) == 1,
                "kind": kind,
                # Only text can become .srt without OCR (L12).
                "extractable": kind == "text",
            })

    return {
        "filename": p.name,
        "path": str(p),
        "format": fmt.get("format_name", "unknown"),
        "duration": float(fmt.get("duration", 0) or 0),
        "size_bytes": int(fmt.get("size", 0) or 0),
        "video_tracks": video_tracks,
        "audio_tracks": audio_tracks,
        "subtitle_tracks": subtitle_tracks,
    }


def _video_rank_key(track: dict) -> tuple[int, int, int]:
    """Rank key for S4 «mejor calidad y compresión»: bigger is better.

    (pixel area, -codec priority, bitrate): quality first, then codec
    efficiency (hevc > h264 > others), bitrate as tiebreak.
    """
    codec = track.get("codec", "").lower()
    area = int(track.get("width", 0) or 0) * int(track.get("height", 0) or 0)
    return (area, -CODEC_PRIORITY.get(codec, 2), int(track.get("bitrate", 0) or 0))


def select_best_video(video_tracks: list[dict]) -> list[dict]:
    """Mark the highest-quality video track as selected (S4).

    Ranks by (resolution, codec efficiency, bitrate); full ties keep the
    first track.
    """
    if not video_tracks:
        return video_tracks

    best = max(video_tracks, key=_video_rank_key)
    for track in video_tracks:
        track["selected"] = track is best
    return video_tracks


def select_best_video_pair(probe_a: dict, probe_b: dict) -> dict | None:
    """Best video track across BOTH files (S4); file A wins full ties.

    Returns {"file": "a"|"b", "path", "track_index" (video-stream ordinal
    for ffmpeg -map v:N), codec, width, height, fps, bitrate}, or None when
    neither file has a video track.
    """
    best: tuple[str, dict, int, dict] | None = None
    best_key: tuple[int, int, int] | None = None
    for label, probe in (("a", probe_a), ("b", probe_b)):
        for ordinal, track in enumerate(probe.get("video_tracks", [])):
            key = _video_rank_key(track)
            if best_key is None or key > best_key:
                best_key = key
                best = (label, probe, ordinal, track)
    if best is None:
        return None
    label, probe, ordinal, track = best
    return {
        "file": label,
        "path": probe.get("path", ""),
        "track_index": ordinal,
        "codec": track.get("codec", "unknown"),
        "width": track.get("width", 0),
        "height": track.get("height", 0),
        "fps": track.get("fps", 0),
        "bitrate": track.get("bitrate", 0),
    }


def check_compatibility(probe_a: dict, probe_b: dict) -> dict:
    """Compare two probed files (S3): ok=False ⇒ the mux must be blocked.

    Returns {"ok", "reasons", "warnings"}: reasons = machine blockers
    (fps_mismatch | duration_mismatch); warnings = UI detail (all mismatches).
    """
    warnings = []
    reasons = []

    # FPS comparison — blocker (exact match, tolerance 0.001; L12 supuesto)
    fps_a = _get_primary_fps(probe_a)
    fps_b = _get_primary_fps(probe_b)
    if fps_a and fps_b and abs(fps_a - fps_b) > 0.001:
        warnings.append({
            "type": "fps_mismatch",
            "message": f"FPS differs: {fps_a} vs {fps_b}",
            "file_a_value": fps_a,
            "file_b_value": fps_b,
        })
        reasons.append("fps_mismatch")

    # Resolution comparison — warning only (never blocks; S3 only names fps/duration)
    res_a = _get_primary_resolution(probe_a)
    res_b = _get_primary_resolution(probe_b)
    if res_a and res_b and res_a != res_b:
        warnings.append({
            "type": "resolution_mismatch",
            "message": f"Resolution differs: {res_a[0]}x{res_a[1]} vs {res_b[0]}x{res_b[1]}",
            "file_a_value": f"{res_a[0]}x{res_a[1]}",
            "file_b_value": f"{res_b[0]}x{res_b[1]}",
        })

    # Duration comparison (>2% relative difference blocks — L12 supuesto)
    dur_a = probe_a.get("duration", 0)
    dur_b = probe_b.get("duration", 0)
    if dur_a > 0 and dur_b > 0:
        diff_pct = abs(dur_a - dur_b) / max(dur_a, dur_b) * 100
        if diff_pct > 2.0:
            warnings.append({
                "type": "duration_mismatch",
                "message": f"Duration differs by {diff_pct:.1f}%: {dur_a:.1f}s vs {dur_b:.1f}s",
                "file_a_value": dur_a,
                "file_b_value": dur_b,
            })
            reasons.append("duration_mismatch")

    return {"ok": not reasons, "reasons": reasons, "warnings": warnings}


def _get_primary_fps(probe: dict) -> float | None:
    """Get FPS from first video track."""
    tracks = probe.get("video_tracks", [])
    if tracks:
        return tracks[0].get("fps")
    return None


def _get_primary_resolution(probe: dict) -> tuple[int, int] | None:
    """Get resolution from first video track."""
    tracks = probe.get("video_tracks", [])
    if tracks:
        return (tracks[0].get("width", 0), tracks[0].get("height", 0))
    return None


def order_and_mark_audio(probe_a: dict, probe_b: dict) -> list[dict]:
    """Merged audio of A+B in the S2 order, with the «4 automáticas» marked.

    Each entry is {**track, "file": "a"|"b", "language_code" (normalized),
    "track_index" (0-based audio ordinal inside its own file), "selected"}.
    Sort: language rank (index in ORDERED_AUDIO_LANGUAGES; other languages
    last, alphabetical by normalized tag) → file (A before B) → bitrate
    descending. The FIRST entry of each ordered language present is
    `selected` (L6: one automatic per language); the rest is «a elegir».
    """
    def _sort_key(entry: dict) -> tuple[int, str, int, int]:
        code = entry["language_code"]
        if code in ORDERED_AUDIO_LANGUAGES:
            return (
                ORDERED_AUDIO_LANGUAGES.index(code),
                "",
                0 if entry["file"] == "a" else 1,
                -(entry.get("bitrate") or 0),
            )
        return (len(ORDERED_AUDIO_LANGUAGES), code, 0 if entry["file"] == "a" else 1, -(entry.get("bitrate") or 0))

    merged: list[dict] = []
    for label, probe in (("a", probe_a), ("b", probe_b)):
        for ordinal, track in enumerate(probe.get("audio_tracks", [])):
            merged.append({
                **track,
                "file": label,
                "language_code": normalize_language(track.get("language", "und")),
                "track_index": ordinal,
                "selected": False,
            })

    merged.sort(key=_sort_key)

    selected: set[str] = set()
    for entry in merged:
        code = entry["language_code"]
        if code in ORDERED_AUDIO_LANGUAGES and code not in selected:
            entry["selected"] = True
            selected.add(code)
    return merged


def check_required_languages(probe_a: dict, probe_b: dict, required: list[str]) -> dict:
    """Availability of the required languages over the UNION of A+B (L3).

    «Solo hace falta que uno de los dos archivos lo tenga» — one file carrying
    the language is enough. Missing ⇒ the mux must be blocked (L14).
    Returns {"ok", "missing", "required"} with canonical comparison.
    """
    available = {
        normalize_language(track.get("language", "und"))
        for probe in (probe_a, probe_b)
        for track in probe.get("audio_tracks", [])
    }
    normalized: list[str] = []
    for tag in required:
        code = normalize_language(tag)
        if code not in normalized:
            normalized.append(code)
    missing = [code for code in normalized if code not in available]
    return {"ok": not missing, "missing": missing, "required": normalized}


def build_mux_command(
    video_source: dict,
    audio_sources: list[dict],
    output_path: str,
) -> list[str]:
    """Build ffmpeg command for mux operation.

    Returns command as list of strings for subprocess.run.
    Uses -c copy for all tracks (stream copy, no re-encode).
    """
    # Collect unique input files
    input_files = []
    file_index = {}

    # Video source
    v_path = video_source["path"]
    if v_path not in file_index:
        file_index[v_path] = len(input_files)
        input_files.append(v_path)

    # Audio sources
    for a in audio_sources:
        a_path = a["path"]
        if a_path not in file_index:
            file_index[a_path] = len(input_files)
            input_files.append(a_path)

    cmd = ["ffmpeg", "-y"]

    # Add inputs
    for f in input_files:
        cmd.extend(["-i", f])

    # Map video track
    v_idx = file_index[video_source["path"]]
    cmd.extend(["-map", f"{v_idx}:v:{video_source['track_index']}"])

    # Map audio tracks
    for a in audio_sources:
        a_idx = file_index[a["path"]]
        cmd.extend(["-map", f"{a_idx}:a:{a['track_index']}"])

    # Stream copy
    cmd.extend(["-c", "copy"])

    # Progress output
    cmd.extend(["-progress", "pipe:1"])

    # Output
    cmd.append(output_path)

    return cmd


def build_subtitle_extract_command(input_path: str, subtitle_ordinal: int, output_path: str) -> list[str]:
    """ffmpeg argv that extracts one text subtitle stream to `.srt` (S6).

    `-map 0:s:{ordinal}` selects the stream; `-c:s srt` re-muxes the text
    container into SubRip. That is subtitle re-muxing, not video transcoding
    (S8 forbids re-encoding, not `.srt` conversion).
    """
    return [
        "ffmpeg", "-y", "-i", input_path,
        "-map", f"0:s:{subtitle_ordinal}",
        "-c:s", "srt",
        output_path,
    ]


def subtitle_sidecar_path(output_path: str, language_code: str) -> str:
    """Sidecar `.srt` path next to the mux output (S6/L12).

    `<output stem>.<suffix>.srt` — short suffix (`es/en/ru/ca`) for the four
    ordered languages, the normalized code otherwise (`…_mixed.es.srt`).
    """
    code = normalize_language(language_code)
    suffix = SHORT_LANGUAGE_SUFFIXES.get(code, code)
    p = Path(output_path)
    return str(p.with_name(f"{p.stem}.{suffix}.srt"))


def _generate_output_path(video_source: dict, output_dir: str) -> str:
    """Generate output path with timestamp naming convention."""
    video_path = Path(video_source["path"])
    stem = video_path.stem
    ext = video_path.suffix
    timestamp = time.strftime("%Y%m%dT%H%M%S")
    filename = f"{stem}_{timestamp}_mixed{ext}"

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    return str(out_dir / filename)


def _substitution_temp_path(destination: str, task_id: str) -> str:
    """Hidden temp file NEXT TO the destination (S11-2).

    Same directory ⇒ same filesystem ⇒ the final `os.replace` is atomic.
    Hidden (leading dot) so pickers and scanners ignore it; the task id keeps
    concurrent jobs from ever colliding on it. The destination's own extension
    is preserved because ffmpeg infers the container from the output name: a
    bare `.tmp` made every substitution mux die with «Unable to choose an
    output format» (rc=234) and a silent «Mux failed».
    """
    dest = Path(destination)
    return str(dest.with_name(f".{dest.stem}.{task_id[:8]}.tmp{dest.suffix}"))


def _finalize_replace(temp_path: str, destination: str) -> bool:
    """S11-2: atomically substitute the destination with the finished temp.

    Only on a verifiable result — the temp must exist with size > 0. Any
    failure returns False so the caller deletes the temp and leaves the
    original untouched.
    """
    try:
        temp = Path(temp_path)
        if not temp.is_file() or temp.stat().st_size <= 0:
            log.error("mux finalize: temp missing or empty temp=%s dest=%s",
                      temp_path, destination)
            return False
        os.replace(temp_path, destination)
        return True
    except OSError as exc:
        # Swallowed by design (original stays intact) — but never silently:
        # this OSError was invisible in the production diagnosis.
        log.error("mux finalize replace failed temp=%s dest=%s: %s",
                  temp_path, destination, exc)
        return False


def _launch(task_id: str) -> None:
    """Start one job's background coroutine on the running loop (S11-4)."""
    try:
        asyncio.get_running_loop().create_task(_run_mux_background(task_id))
    except RuntimeError:  # no loop to run on: nothing could progress anyway
        log.warning("mux task %s could not be launched: no running loop", task_id)


def _release_slot(task_id: str) -> None:
    """Free the single mux slot and start the next `queued` job (S11-4).

    FIFO: the oldest queued task wins. Entries already cancelled or gone are
    dropped without running («cancelar una queued la retira sin ejecutarla»).
    A task that never held the slot advances nothing.
    """
    next_id = None
    global _mux_active
    with _mux_lock:
        if _mux_active != task_id:
            return
        _mux_active = None
        while _mux_queue:
            candidate = _mux_queue.popleft()
            task = mux_tasks.get(candidate)
            if task is not None and task.get("status") == "queued" and not task.get("cancelled"):
                next_id = candidate
                break
            _pending_jobs.pop(candidate, None)
        if next_id is not None:
            _mux_active = next_id
    if next_id is not None:
        mux_tasks.update(next_id, status="running", detail="Starting mux...")
        _launch(next_id)


def start_mux(
    video_source: dict,
    audio_sources: list[dict],
    output_dir: str,
    subtitle_plan: list[dict] | None = None,
    destination_path: str = "",
) -> str:
    """Start a mux task (or queue it — one mux at a time, S11-4). Returns task_id.

    Creates the task dict and launches the background coroutine, or marks it
    `queued` when another mux holds the slot (FIFO start on completion).
    `subtitle_plan` (S6) is copied into the task as `subtitles` (statuses
    start `pending`) and resolved by the background run after a successful
    mux. S11-1/S11-2: a non-empty `destination_path` means substitution mode
    — ffmpeg writes a hidden temp NEXT TO the destination and the atomic
    `os.replace` is the last step of the task; the `output_path` reported for
    the task is the destination itself. Empty `destination_path` keeps the
    legacy generated-name directory mode unchanged.
    """
    task_id = str(uuid.uuid4())
    subtitles = [dict(entry) for entry in (subtitle_plan or [])]
    if destination_path:
        write_path = _substitution_temp_path(destination_path, task_id)
        output_path = destination_path
    else:
        write_path = _generate_output_path(video_source, output_dir)
        output_path = write_path

    job = {
        "cmd": build_mux_command(video_source, audio_sources, write_path),
        "write_path": write_path,
        "output_path": output_path,
        "subtitles": subtitles,
        "replace": bool(destination_path),
    }

    global _mux_active
    with _mux_lock:
        start_now = _mux_active is None
        if start_now:
            _mux_active = task_id
        else:
            _mux_queue.append(task_id)

    mux_tasks.create(task_id,
        channel="mixer",
        status="running" if start_now else "queued",
        progress=0.0,
        detail="Starting mux..." if start_now else "Queued",
        output_path=None,
        cancelled=False,
        paused=False,
        pause_event=threading.Event(),
        process=None,
        subtitles=subtitles,
    )
    mux_tasks._tasks[task_id]["pause_event"].set()  # Not paused initially
    _pending_jobs[task_id] = job

    if start_now:
        _launch(task_id)

    return task_id


def _run_ffmpeg(task_id: str, cmd: list[str], pause_event: threading.Event) -> str:
    """Run one ffmpeg mux in a worker thread with pause/cancel support.

    S11-3: `-progress pipe:1` emits the progress protocol on STDOUT
    (`out_time_us=`, `progress=end`); stderr only carries the banner
    (`Duration:`, parsed for the total) and diagnostics. Both pipes are read
    — stdout here, stderr on a drain thread — so neither can fill its buffer
    and block ffmpeg («never leave a pipe unread»).
    """
    drain: threading.Thread | None = None
    banner = threading.Event()
    # tail: last stderr lines kept for diagnosability — on rc≠0 they become the
    # task detail, because the old silent branch hid why production muxes died.
    state = {"duration": 0.0, "tail": deque(maxlen=10)}
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        task = mux_tasks.get(task_id)
        if task is not None:
            task["process"] = proc

        def _drain_stderr():
            try:
                for line in proc.stderr:
                    decoded = line.decode("utf-8", errors="ignore").strip()
                    state["tail"].append(decoded)  # diagnosability: kept for rc≠0
                    # Parse duration from the ffmpeg banner (first lines)
                    if decoded.startswith("Duration:") and state["duration"] == 0:
                        try:
                            dur_str = decoded.split("Duration:")[1].split(",")[0].strip()
                            h, m, s = dur_str.split(":")
                            state["duration"] = float(h) * 3600 + float(m) * 60 + float(s)
                        except (ValueError, IndexError):
                            pass
            finally:
                banner.set()  # parsed, or EOF — the wait below must never hang

        drain = threading.Thread(target=_drain_stderr, daemon=True)
        drain.start()
        # The banner (hence the total duration) precedes the first progress
        # tick; bounded wait so a banner-less ffmpeg can never deadlock.
        banner.wait(timeout=5)

        for line in proc.stdout:
            if not line:
                continue

            # Check for cancellation
            if task is not None and task.get("cancelled"):
                proc.terminate()
                return "cancelled"

            # Check for pause
            if not pause_event.is_set():
                proc.kill()
                return "paused"

            decoded = line.decode("utf-8", errors="ignore").strip()

            # Parse progress from the -progress protocol (stdout, S11-3)
            if decoded.startswith("out_time_us="):
                duration = state["duration"]
                if duration > 0:
                    try:
                        us = int(decoded.split("=")[1])
                        current = us / 1_000_000
                        ratio = min(current / duration, 0.99)
                        mux_tasks.update(task_id, progress=ratio, detail=f"Muxing... {int(ratio * 100)}%")
                    except (ValueError, IndexError):
                        pass
            elif decoded == "progress=end":
                mux_tasks.update(task_id, progress=1.0)
                break

        proc.wait()
        if proc.returncode == 0:
            return "done"
        # rc ≠ 0: join the drain first so the tail is complete, then make the
        # failure legible wherever the task is read (detail) and in the log.
        if drain is not None:
            drain.join(timeout=2)
        tail = list(state["tail"])
        log.error(
            "ffmpeg mux %s exited rc=%s; stderr tail: %s",
            task_id, proc.returncode, " | ".join(tail[-3:]) or "(empty)",
        )
        last = tail[-1] if tail else "no stderr output"
        mux_tasks.update(
            task_id, detail=f"Mux failed (ffmpeg rc={proc.returncode}): {last}"
        )
        return "error"
    except Exception as exc:
        log.exception("ffmpeg mux %s raised", task_id)
        mux_tasks.update(task_id, detail=f"Mux failed ({type(exc).__name__}: {exc})")
        return "error"
    finally:
        if drain is not None:
            drain.join(timeout=5)


async def _run_mux_background(task_id: str):
    """Background coroutine that runs one mux job and tracks progress.

    After a successful mux it extracts the planned `.srt` sidecars (S6/S8);
    in substitution mode (S11-2) the atomic replace of the destination is the
    LAST step, so extraction still reads the original files. Pause does not
    apply during extraction; cancel only stops it. S11-4: the single mux slot
    is freed when the run settles — a paused task keeps it until resumed or
    cancelled.
    """
    task = mux_tasks.get(task_id)
    job = _pending_jobs.get(task_id) or {}
    if not task:
        _pending_jobs.pop(task_id, None)
        _release_slot(task_id)
        return

    cmd = job.get("cmd") or []
    output_path = job.get("output_path", "")
    write_path = job.get("write_path") or output_path
    replace = bool(job.get("replace"))
    subtitles = job.get("subtitles") or []

    pause_event = task.get("pause_event")
    if pause_event is None:
        pause_event = threading.Event()
        task["pause_event"] = pause_event
    if task.get("paused"):
        pause_event.clear()
    else:
        pause_event.set()

    try:
        result = await asyncio.to_thread(_run_ffmpeg, task_id, cmd, pause_event)

        if result == "cancelled":
            _cleanup_partial(write_path)
            for entry in subtitles:
                if entry.get("status") == "pending":
                    entry["status"] = "skipped"
            mux_tasks.update(task_id,
                status="cancelled",
                detail="Task cancelled",
                progress=0.0,
            )
        elif result == "paused":
            mux_tasks.update(task_id,
                status="paused",
                detail="Task paused",
            )
        elif result == "done":
            await _extract_subtitles(task, subtitles, output_path)
            if replace and task.get("cancelled"):
                # S11-2: a cancelled substitution never consumes the original.
                _cleanup_partial(write_path)
                for entry in subtitles:
                    if entry.get("status") == "pending":
                        entry["status"] = "skipped"
                mux_tasks.update(task_id,
                    status="cancelled",
                    detail="Task cancelled",
                    progress=0.0,
                )
            elif replace and not _finalize_replace(write_path, output_path):
                # No verifiable output to replace with: original stays intact.
                _cleanup_partial(write_path)
                mux_tasks.update(task_id,
                    status="error",
                    detail="Mux failed",
                    progress=0.0,
                )
            else:
                mux_tasks.update(task_id,
                    status="done",
                    progress=1.0,
                    detail="Mux complete",
                    output_path=output_path,
                )
        else:
            _cleanup_partial(write_path)
            # _run_ffmpeg already recorded WHY it failed (stderr tail or the
            # raised exception). Keep that reason; only fall back to the bare
            # label when nothing was captured — never clobber the diagnosis.
            current = mux_tasks.get(task_id) or {}
            reason = current.get("detail") or ""
            if not reason.startswith("Mux failed"):
                reason = "Mux failed"
            mux_tasks.update(task_id,
                status="error",
                detail=reason,
                progress=0.0,
            )
    except Exception as exc:
        log.exception("mux task %s failed", task_id)
        _cleanup_partial(write_path)
        mux_tasks.update(task_id,
            status="error",
            detail=f"{type(exc).__name__}: {exc}",
        )
    finally:
        task = mux_tasks.get(task_id) or {}
        task.pop("process", None)
        task.pop("pause_event", None)
        # S11-4: paused is not finished — the task keeps the slot until it is
        # resumed or cancelled; every other outcome frees it for the next job.
        if task.get("status") != "paused":
            _pending_jobs.pop(task_id, None)
            _release_slot(task_id)


def _cleanup_partial(path: str):
    """Delete partial output file if it exists."""
    try:
        p = Path(path)
        if p.exists():
            p.unlink()
    except OSError:
        pass


def _run_extract(cmd: list[str]) -> tuple[int, str]:
    """Run one subtitle-extraction ffmpeg (Popen, same as the mux)."""
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    _, err = proc.communicate()
    return proc.returncode, (err or b"").decode("utf-8", errors="ignore")


def _stderr_snippet(stderr: str) -> str:
    """Short ffmpeg failure detail: last non-empty stderr line, capped."""
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    return lines[-1][:200] if lines else "extraction failed"


async def _extract_subtitles(task: dict, subtitles: list[dict], output_path: str) -> None:
    """Resolve the subtitle plan after a successful mux (S6/S8).

    Entries pre-marked `not_extractable` (bitmap/unknown codec, L12) or
    `missing` (no track — T6 fills those via OpenSubtitles) keep those
    statuses; the rest get extracted or become `skipped` on cancel. Pause
    does not apply during extraction.
    """
    for entry in subtitles:
        if entry.get("status") != "pending":
            continue
        if entry.get("track_index") is None:
            entry["status"] = "missing"
        elif not entry.get("extractable"):
            codec = entry.get("codec", "unknown")
            entry["status"] = "not_extractable"
            entry["detail"] = f"{_subtitle_kind(codec)}: {codec}"

    for entry in subtitles:
        if entry.get("status") != "pending":
            continue
        if task.get("cancelled"):
            entry["status"] = "skipped"
            continue
        sidecar = subtitle_sidecar_path(output_path, entry["language_code"])
        cmd = build_subtitle_extract_command(entry.get("path", ""), entry["track_index"], sidecar)
        try:
            code, stderr = await asyncio.to_thread(_run_extract, cmd)
        except Exception as exc:  # noqa: BLE001 — a sidecar never fails the mux
            entry["status"] = "failed"
            entry["detail"] = f"{type(exc).__name__}: {exc}"
            continue
        if code == 0:
            entry["status"] = "extracted"
            entry["sidecar"] = sidecar
        else:
            entry["status"] = "failed"
            entry["detail"] = _stderr_snippet(stderr)


def cancel_task(task_id: str) -> dict:
    """Cancel a running, paused or queued task.

    A cancelled `queued` task is terminal at once and NEVER runs (S11-4);
    a cancelled `paused` task frees the single mux slot for the next job.
    """
    task = mux_tasks.get(task_id)
    if not task:
        return {"ok": False, "detail": "Task not found"}

    if task["status"] not in ("running", "paused", "pending", "queued"):
        return {"ok": False, "detail": "Task is not running"}

    task["cancelled"] = True
    pause_event = task.get("pause_event")
    if pause_event:
        pause_event.set()  # Unblock if paused

    proc = task.get("process")
    if proc:
        try:
            proc.terminate()
        except OSError:
            pass

    if task["status"] in ("queued", "paused"):
        # No run loop will settle these: terminal state now, and the slot
        # moves on to the next queued job (S11-4).
        mux_tasks.update(task_id,
            status="cancelled",
            detail="Task cancelled",
            progress=0.0,
        )
        _pending_jobs.pop(task_id, None)
        _release_slot(task_id)

    return {"ok": True, "detail": "Task cancelled"}


def pause_task(task_id: str) -> dict:
    """Pause a running task."""
    task = mux_tasks.get(task_id)
    if not task:
        return {"ok": False, "detail": "Task not found"}

    if task["status"] != "running":
        return {"ok": False, "detail": "Task is not running"}

    task["paused"] = True
    pause_event = task.get("pause_event")
    if pause_event:
        pause_event.clear()

    return {"ok": True, "detail": "Task paused"}


def resume_task(task_id: str) -> dict:
    """Resume a paused task (S11-4: relaunch its run — pause killed ffmpeg)."""
    task = mux_tasks.get(task_id)
    if not task:
        return {"ok": False, "detail": "Task not found"}

    if task["status"] != "paused":
        return {"ok": False, "detail": "Task is not paused"}

    task["paused"] = False
    task["status"] = "running"
    task["detail"] = "Resuming mux..."
    pause_event = task.get("pause_event")
    if pause_event:
        pause_event.set()

    # Pause kills the ffmpeg process, so resuming restarts the mux run from
    # the stored job (-c copy is cheap). Tasks without a stored job (created
    # outside start_mux) keep the plain status change.
    if task_id in _pending_jobs and _mux_active == task_id:
        _launch(task_id)

    return {"ok": True, "detail": "Task resumed"}


def get_task(task_id: str) -> dict | None:
    """Get task status. Returns None if not found or expired."""
    task = mux_tasks.get(task_id)
    if not task:
        return None

    return {
        "task_id": task_id,
        "status": task["status"],
        "progress": task.get("progress", 0.0),
        "detail": task.get("detail", ""),
        "output_path": task.get("output_path"),
        "created_at": task.get("created_at", 0),
        "subtitles": task.get("subtitles", []),
    }


def cleanup_tasks():
    """Remove completed tasks older than TTL."""
    mux_tasks.cleanup()
