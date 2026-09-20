import asyncio
import json
import logging
import os
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from settings import get_setting

log = logging.getLogger("flow-controller")

# Shared task state (mirrors copy_engine.py pattern)
_tasks: dict[str, dict] = {}
_task_lock = asyncio.Lock()

# Priority: hevc > h264 > other (lower index = higher priority)
CODEC_PRIORITY: dict[str, int] = {"hevc": 0, "h265": 0, "h264": 1, "avc": 1}


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

    for s in streams:
        codec_type = s.get("codec_type")
        if codec_type == "video":
            fps_str = s.get("r_frame_rate", "0/1")
            try:
                num, den = fps_str.split("/")
                fps = float(num) / float(den) if float(den) != 0 else 0.0
            except (ValueError, ZeroDivisionError):
                fps = 0.0

            video_tracks.append({
                "index": s.get("index", 0),
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
                "codec": s.get("codec_name", "unknown"),
                "language": language,
                "channels": s.get("channels", 0),
                "bitrate": int(s.get("bit_rate", 0) or 0),
                "default": default,
            })

    return {
        "filename": p.name,
        "path": str(p),
        "format": fmt.get("format_name", "unknown"),
        "duration": float(fmt.get("duration", 0) or 0),
        "size_bytes": int(fmt.get("size", 0) or 0),
        "video_tracks": video_tracks,
        "audio_tracks": audio_tracks,
    }


def select_best_video(video_tracks: list[dict]) -> list[dict]:
    """Mark the highest-quality video track as selected.

    Priority: hevc/h265 > h264/avc > others.
    If multiple tracks have same priority, first one wins.
    """
    if not video_tracks:
        return video_tracks

    best_idx = 0
    best_priority = 999

    for i, track in enumerate(video_tracks):
        codec = track.get("codec", "").lower()
        priority = CODEC_PRIORITY.get(codec, 2)
        if priority < best_priority:
            best_priority = priority
            best_idx = i

    for i, track in enumerate(video_tracks):
        track["selected"] = i == best_idx

    return video_tracks


def check_compatibility(probe_a: dict, probe_b: dict) -> dict:
    """Compare two probed files for compatibility.

    Returns:
        {
            "ok": True,  # always True (warnings don't block)
            "warnings": [...]
        }
    """
    warnings = []

    # FPS comparison
    fps_a = _get_primary_fps(probe_a)
    fps_b = _get_primary_fps(probe_b)
    if fps_a and fps_b and abs(fps_a - fps_b) > 0.001:
        warnings.append({
            "type": "fps_mismatch",
            "message": f"FPS differs: {fps_a} vs {fps_b}",
            "file_a_value": fps_a,
            "file_b_value": fps_b,
        })

    # Resolution comparison
    res_a = _get_primary_resolution(probe_a)
    res_b = _get_primary_resolution(probe_b)
    if res_a and res_b and res_a != res_b:
        warnings.append({
            "type": "resolution_mismatch",
            "message": f"Resolution differs: {res_a[0]}x{res_a[1]} vs {res_b[0]}x{res_b[1]}",
            "file_a_value": f"{res_a[0]}x{res_a[1]}",
            "file_b_value": f"{res_b[0]}x{res_b[1]}",
        })

    # Duration comparison (>5% difference)
    dur_a = probe_a.get("duration", 0)
    dur_b = probe_b.get("duration", 0)
    if dur_a > 0 and dur_b > 0:
        diff_pct = abs(dur_a - dur_b) / max(dur_a, dur_b) * 100
        if diff_pct > 5.0:
            warnings.append({
                "type": "duration_mismatch",
                "message": f"Duration differs by {diff_pct:.1f}%: {dur_a:.1f}s vs {dur_b:.1f}s",
                "file_a_value": dur_a,
                "file_b_value": dur_b,
            })

    return {"ok": True, "warnings": warnings}


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


def start_mux(
    video_source: dict,
    audio_sources: list[dict],
    output_dir: str,
) -> str:
    """Start a mux task. Returns task_id.

    Creates task dict, launches background coroutine.
    """
    task_id = str(uuid.uuid4())
    output_path = _generate_output_path(video_source, output_dir)

    _tasks[task_id] = {
        "status": "running",
        "progress": 0.0,
        "detail": "Starting mux...",
        "output_path": None,
        "created_at": time.time(),
        "cancelled": False,
        "paused": False,
        "pause_event": threading.Event(),
        "process": None,
    }
    _tasks[task_id]["pause_event"].set()  # Not paused initially

    cmd = build_mux_command(video_source, audio_sources, output_path)
    asyncio.create_task(_run_mux_background(task_id, cmd, output_path))

    return task_id


async def _run_mux_background(task_id: str, cmd: list[str], output_path: str):
    """Background coroutine that runs ffmpeg and tracks progress."""
    task = _tasks.get(task_id)
    if not task:
        return

    pause_event = task["pause_event"]

    def _run_ffmpeg():
        """Run ffmpeg in a thread with pause support."""
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        task["process"] = proc

        duration = 0.0
        try:
            for line in proc.stderr:
                if not line:
                    continue

                # Check for cancellation
                if task.get("cancelled"):
                    proc.terminate()
                    return "cancelled"

                # Check for pause
                if not pause_event.is_set():
                    proc.kill()
                    return "paused"

                decoded = line.decode("utf-8", errors="ignore").strip()

                # Parse duration from ffprobe (first line)
                if decoded.startswith("Duration:") and duration == 0:
                    try:
                        dur_str = decoded.split("Duration:")[1].split(",")[0].strip()
                        h, m, s = dur_str.split(":")
                        duration = float(h) * 3600 + float(m) * 60 + float(s)
                    except (ValueError, IndexError):
                        pass

                # Parse progress from -progress output
                if decoded.startswith("out_time_us=") and duration > 0:
                    try:
                        us = int(decoded.split("=")[1])
                        current = us / 1_000_000
                        task["progress"] = min(current / duration, 0.99)
                        task["detail"] = f"Muxing... {int(task['progress'] * 100)}%"
                    except (ValueError, IndexError):
                        pass

                if decoded == "progress=end":
                    task["progress"] = 1.0
                    break

            proc.wait()
            return "done" if proc.returncode == 0 else "error"
        except Exception:
            return "error"

    try:
        result = await asyncio.to_thread(_run_ffmpeg)

        if result == "cancelled":
            _cleanup_partial(output_path)
            task.update({
                "status": "cancelled",
                "detail": "Task cancelled",
                "progress": 0.0,
            })
        elif result == "paused":
            task.update({
                "status": "paused",
                "detail": "Task paused",
            })
        elif result == "done":
            task.update({
                "status": "done",
                "progress": 1.0,
                "detail": "Mux complete",
                "output_path": output_path,
            })
        else:
            _cleanup_partial(output_path)
            task.update({
                "status": "error",
                "detail": "Mux failed",
                "progress": 0.0,
            })
    except Exception as exc:
        log.exception("mux task %s failed", task_id)
        _cleanup_partial(output_path)
        task.update({
            "status": "error",
            "detail": f"{type(exc).__name__}: {exc}",
        })
    finally:
        task.pop("process", None)
        task.pop("pause_event", None)


def _cleanup_partial(path: str):
    """Delete partial output file if it exists."""
    try:
        p = Path(path)
        if p.exists():
            p.unlink()
    except OSError:
        pass


def cancel_task(task_id: str) -> dict:
    """Cancel a running task."""
    task = _tasks.get(task_id)
    if not task:
        return {"ok": False, "detail": "Task not found"}

    if task["status"] not in ("running", "paused", "pending"):
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

    return {"ok": True, "detail": "Task cancelled"}


def pause_task(task_id: str) -> dict:
    """Pause a running task."""
    task = _tasks.get(task_id)
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
    """Resume a paused task."""
    task = _tasks.get(task_id)
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

    return {"ok": True, "detail": "Task resumed"}


def get_task(task_id: str) -> dict | None:
    """Get task status. Returns None if not found or expired."""
    task = _tasks.get(task_id)
    if not task:
        return None

    # Check TTL (600s)
    if task["status"] in ("done", "error", "cancelled"):
        if time.time() - task.get("created_at", 0) > 600:
            del _tasks[task_id]
            return None

    return {
        "task_id": task_id,
        "status": task["status"],
        "progress": task.get("progress", 0.0),
        "detail": task.get("detail", ""),
        "output_path": task.get("output_path"),
        "created_at": task.get("created_at", 0),
    }


def cleanup_tasks():
    """Remove completed tasks older than 600s TTL."""
    now = time.time()
    expired = [
        tid for tid, t in _tasks.items()
        if t.get("status") not in ("running", "paused", "pending")
        and now - t.get("created_at", 0) > 600
    ]
    for tid in expired:
        del _tasks[tid]
