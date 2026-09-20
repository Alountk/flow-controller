"""Media Mixer API routes for flow-controller.

Provides endpoints for probing media files, muxing audio/video tracks,
and managing mux tasks (list, status, cancel, pause, resume).
"""
import logging
import os

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from media_mixer import (
    probe_file,
    check_compatibility,
    start_mux,
    cancel_task,
    pause_task,
    resume_task,
    get_task,
    cleanup_tasks,
)
from task_manager import mux_tasks
from config import API_KEY

log = logging.getLogger("flow-controller")

router = APIRouter(prefix="/api/mixer", tags=["mixer"])

# ── Auth ──────────────────────────────────────────────────────────────────────


async def verify_api_key(x_api_key: str | None = Header(default=None)):
    if not API_KEY:
        return
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="API key inválida")


# ── Pydantic Models ──────────────────────────────────────────────────────────


class ProbeRequest(BaseModel):
    path_a: str
    path_b: str


class MuxRequest(BaseModel):
    video_source: dict
    audio_sources: list[dict]
    output_path: str = ""


# ── Path validation ──────────────────────────────────────────────────────────

ALLOWED_ROOTS = ["/mnt/storage", "/mnt/storage-6tb"]


def _validate_mixer_path(path: str) -> str:
    """Validate path is under allowed roots. Returns resolved path."""
    if not path:
        raise HTTPException(status_code=400, detail="Path is empty")
    resolved = os.path.realpath(path)
    for root in ALLOWED_ROOTS:
        if resolved == root or resolved.startswith(root + "/"):
            return resolved
    raise HTTPException(status_code=403, detail=f"Path not allowed: {path}")


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.post("/probe")
async def mixer_probe(req: ProbeRequest, _key: str = Depends(verify_api_key)):
    """Probe two media files and check compatibility.

    Accepts two file paths (absolute or relative to allowed roots).
    Returns track metadata for both files plus compatibility warnings.
    """
    try:
        path_a = _validate_mixer_path(req.path_a)
        path_b = _validate_mixer_path(req.path_b)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if not os.path.isfile(path_a):
        raise HTTPException(status_code=400, detail=f"File not found: {req.path_a}")
    if not os.path.isfile(path_b):
        raise HTTPException(status_code=400, detail=f"File not found: {req.path_b}")

    try:
        probe_a = probe_file(path_a)
        probe_b = probe_file(path_b)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    compatibility = check_compatibility(probe_a, probe_b)

    return {
        "file_a": probe_a,
        "file_b": probe_b,
        "compatibility": compatibility,
    }


@router.post("/mux")
async def mixer_mux(req: MuxRequest, _key: str = Depends(verify_api_key)):
    """Start a mux task combining video and audio tracks.

    Returns task_id for polling status.
    """
    # Validate video source path
    video_path = req.video_source.get("path", "")
    if not video_path:
        raise HTTPException(status_code=400, detail="video_source.path is required")

    try:
        validated_video_path = _validate_mixer_path(video_path)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if not os.path.isfile(validated_video_path):
        raise HTTPException(status_code=400, detail=f"Video file not found: {video_path}")

    # Validate audio source paths
    for i, audio in enumerate(req.audio_sources):
        audio_path = audio.get("path", "")
        if not audio_path:
            raise HTTPException(status_code=400, detail=f"audio_sources[{i}].path is required")
        try:
            validated_audio_path = _validate_mixer_path(audio_path)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if not os.path.isfile(validated_audio_path):
            raise HTTPException(status_code=400, detail=f"Audio file not found: {audio_path}")

    # Determine output directory
    from settings import get_setting
    output_dir = req.output_path or get_setting("paths", "output_mixed", default="/mnt/storage/mixed")

    # Build validated video source with absolute path
    video_source = {
        "path": validated_video_path,
        "track_index": req.video_source.get("track_index", 0),
    }

    # Build validated audio sources with absolute paths
    audio_sources = []
    for audio in req.audio_sources:
        audio_sources.append({
            "path": os.path.realpath(audio["path"]),
            "track_index": audio.get("track_index", 0),
        })

    try:
        task_id = start_mux(video_source, audio_sources, output_dir)
    except Exception as exc:
        log.exception("mux start failed")
        raise HTTPException(status_code=500, detail=f"Failed to start mux: {exc}")

    return {
        "ok": True,
        "task_id": task_id,
        "detail": "Mux task started",
    }


@router.get("/tasks")
async def mixer_list_tasks(_key: str = Depends(verify_api_key)):
    """List all mixer tasks with their status."""
    cleanup_tasks()

    tasks = []
    for task_id, task in mux_tasks.all_tasks().items():
        tasks.append({
            "task_id": task_id,
            "status": task.get("status", "unknown"),
            "progress": task.get("progress", 0.0),
            "detail": task.get("detail", ""),
            "output_path": task.get("output_path"),
            "created_at": task.get("created_at", 0),
        })

    return {"tasks": tasks}


@router.get("/tasks/{task_id}")
async def mixer_get_task(task_id: str, _key: str = Depends(verify_api_key)):
    """Get status of a single mixer task."""
    cleanup_tasks()

    task = get_task(task_id)
    if not task:
        return {"ok": False, "detail": "Task not found"}

    return {"ok": True, **task}


@router.post("/tasks/{task_id}/cancel")
async def mixer_cancel_task(task_id: str, _key: str = Depends(verify_api_key)):
    """Cancel a running mixer task."""
    result = cancel_task(task_id)
    if not result["ok"]:
        return result

    # Return updated task status
    task = get_task(task_id)
    return {"ok": True, **(task or {}), "detail": result.get("detail", "Task cancelled")}


@router.post("/tasks/{task_id}/pause")
async def mixer_pause_task(task_id: str, _key: str = Depends(verify_api_key)):
    """Pause a running mixer task."""
    result = pause_task(task_id)
    if not result["ok"]:
        return result

    # Return updated task status
    task = get_task(task_id)
    return {"ok": True, **(task or {}), "detail": result.get("detail", "Task paused")}


@router.post("/tasks/{task_id}/resume")
async def mixer_resume_task(task_id: str, _key: str = Depends(verify_api_key)):
    """Resume a paused mixer task."""
    result = resume_task(task_id)
    if not result["ok"]:
        return result

    # Return updated task status
    task = get_task(task_id)
    return {"ok": True, **(task or {}), "detail": result.get("detail", "Task resumed")}
