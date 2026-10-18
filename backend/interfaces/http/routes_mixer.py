"""Media Mixer API routes for flow-controller.

Provides endpoints for probing media files, muxing audio/video tracks,
and managing mux tasks (list, status, cancel, pause, resume).
"""
import asyncio
import logging
import os
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from media_mixer import (
    probe_file,
    check_compatibility,
    check_required_languages,
    normalize_language,
    order_and_mark_audio,
    select_best_video_pair,
    start_mux,
    cancel_task,
    pause_task,
    resume_task,
    get_task,
    cleanup_tasks,
    subtitle_sidecar_path,
    ORDERED_AUDIO_LANGUAGES,
    SHORT_LANGUAGE_SUFFIXES,
)
from task_manager import mux_tasks
from application.gateways import download_subtitle, get_setting, search_subtitles
from application.ports import OpenSubtitlesError
from interfaces.http.deps import verify_api_key
import config

log = logging.getLogger("flow-controller")

router = APIRouter(prefix="/api/mixer", tags=["mixer"])

# ── Pydantic Models ──────────────────────────────────────────────────────────


class ProbeRequest(BaseModel):
    path_a: str
    path_b: str


class MuxRequest(BaseModel):
    video_source: dict
    audio_sources: list[dict]
    output_path: str = ""


class SubtitleSearchRequest(BaseModel):
    languages: list[str] | None = None


# ── Path validation ──────────────────────────────────────────────────────────

ALLOWED_ROOTS = config.ALLOWED_ROOTS


def _validate_mixer_path(path: str) -> str:
    """Validate path is under allowed roots. Returns resolved path."""
    if not path:
        raise HTTPException(status_code=400, detail="Path is empty")
    resolved = os.path.realpath(path)
    for root in ALLOWED_ROOTS:
        if resolved == root or resolved.startswith(root + "/"):
            return resolved
    raise HTTPException(status_code=403, detail=f"Path not allowed: {path}")


def _required_languages() -> list[str]:
    """Required languages from settings, normalized, with `spa` forced first.

    L3: «Castellano tiene que estar siempre, es el minimo» — whatever the
    user configures (default «Solo castellano», L9), castellano can never
    be dropped. Deduped, configured order preserved after `spa`.
    """
    from application.gateways import get_setting

    configured = get_setting("mixer", "required_languages", default=["spa"]) or []
    result: list[str] = []
    for tag in ["spa", *(t for t in configured if isinstance(t, str))]:
        code = normalize_language(tag)
        if code not in result:
            result.append(code)
    return result


def _build_subtitle_plan(probes: list[dict]) -> list[dict]:
    """S6: one `.srt` sidecar plan entry per audio language of the files.

    «los mismos idiomas de audio» — the union of all audio languages. For
    each language at most ONE subtitle track is picked (extractable beats
    bitmap/unknown across files, then first file, first track); languages
    with no track still get an entry (T6 fills those via OpenSubtitles).
    Entries start `pending`; the background run resolves them.
    """
    def _rank(code: str) -> tuple[int, int | str]:
        if code in ORDERED_AUDIO_LANGUAGES:
            return (0, ORDERED_AUDIO_LANGUAGES.index(code))
        return (1, code)

    audio_langs = {
        normalize_language(track.get("language", "und"))
        for probe in probes
        for track in probe.get("audio_tracks", [])
    }

    plan: list[dict] = []
    for code in sorted(audio_langs, key=_rank):
        candidates = [
            (probe, track)
            for probe in probes
            for track in probe.get("subtitle_tracks", [])
            if track.get("language_code") == code
        ]
        chosen = next(((p, t) for p, t in candidates if t.get("extractable")), None)
        if chosen is None and candidates:
            chosen = candidates[0]

        entry = {
            "language_code": code,
            "language": SHORT_LANGUAGE_SUFFIXES.get(code, code),
            "path": None,
            "track_index": None,
            "codec": None,
            "extractable": False,
            "status": "pending",
            "detail": "",
            "sidecar": None,
        }
        if chosen:
            probe, track = chosen
            entry["path"] = probe.get("path", "")
            entry["track_index"] = track.get("track_index")
            entry["codec"] = track.get("codec", "unknown")
            entry["extractable"] = bool(track.get("extractable"))
        plan.append(entry)
    return plan


#: Plan entries T6 can fill by searching: the extraction could not give these.
#: `extracted`/`downloaded` are never re-searched.
_SEARCHABLE_STATUSES = {"missing", "not_extractable", "failed"}


def _title_from_output_path(output_path: str) -> str:
    """Search title: the output stem minus `_mixed` and the timestamp.

    `_generate_output_path` names the output `<stem>_<YYYYMMDDTHHMMSS>_mixed<ext>`;
    the search query is the original stem (S6: find subtitles for the same
    audio languages).
    """
    stem = os.path.splitext(os.path.basename(output_path))[0]
    stem = re.sub(r"_mixed$", "", stem)
    return re.sub(r"_\d{8}T\d{6}$", "", stem)


def _fetch_sidecar(api_key: str, query: str, language_code: str, output_path: str) -> dict:
    """Search + download one `.srt` into the output sidecar (S6/T6).

    Blocking (HTTP + file write): the route runs it through
    `asyncio.to_thread` — one event loop, and it does not preempt. Raises
    `OpenSubtitlesError`; the route annotates that entry and continues.
    """
    candidates = search_subtitles(api_key, query, languages=language_code)
    if not candidates:
        return {"detail": "not_found"}
    text = download_subtitle(api_key, candidates[0]["file_id"])
    sidecar = subtitle_sidecar_path(output_path, language_code)
    with open(sidecar, "w", encoding="utf-8") as fh:
        fh.write(text)
    return {"status": "downloaded", "sidecar": sidecar, "detail": ""}


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
        # ffprobe is a subprocess with a 30 s timeout, twice per request. Inline
        # it would freeze every other request for up to a minute: there is only
        # one event loop, and it does not preempt.
        probe_a = await asyncio.to_thread(probe_file, path_a)
        probe_b = await asyncio.to_thread(probe_file, path_b)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    compatibility = check_compatibility(probe_a, probe_b)

    return {
        "file_a": probe_a,
        "file_b": probe_b,
        "compatibility": compatibility,
        "best_video": select_best_video_pair(probe_a, probe_b),
        "language_check": check_required_languages(probe_a, probe_b, _required_languages()),
        "audio_ordered": order_and_mark_audio(probe_a, probe_b),
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

    # S3 compatibility gate: the client's badge is UI sugar — the backend
    # re-probes every distinct file involved and blocks an incompatible mux
    # with 409 BEFORE any ffmpeg process starts.
    unique_files = list(dict.fromkeys(
        [validated_video_path]
        + [os.path.realpath(a["path"]) for a in req.audio_sources]
    ))
    subtitle_plan: list[dict] = []
    if len(unique_files) > 1:
        try:
            probes = await asyncio.gather(
                *(asyncio.to_thread(probe_file, f) for f in unique_files)
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc))
        anchor = probes[0]
        for other in probes[1:]:
            compatibility = check_compatibility(anchor, other)
            if not compatibility["ok"]:
                raise HTTPException(status_code=409, detail={
                    "error": "incompatible",
                    "reasons": compatibility["reasons"],
                    "compatibility": compatibility,
                })

        # S2/L14 required-language gate — after the fps/duration check (S3
        # «el primer check») and still BEFORE any ffmpeg starts. Availability
        # is checked over the UNION of the probed files (L3: one of the two
        # files carrying the language is enough).
        required = _required_languages()
        available = {
            normalize_language(track.get("language", "und"))
            for probe in probes
            for track in probe.get("audio_tracks", [])
        }
        missing = [code for code in required if code not in available]
        if missing:
            raise HTTPException(status_code=409, detail={
                "error": "missing_required_language",
                "missing": missing,
                "required": required,
            })

        # S6: .srt sidecar plan derived server-side from the probes (the
        # client's languages are never trusted) — one entry per audio
        # language of the A+B union.
        subtitle_plan = _build_subtitle_plan(list(probes))

    # Determine output directory
    from application.gateways import get_setting
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
        task_id = start_mux(video_source, audio_sources, output_dir, subtitle_plan=subtitle_plan)
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


@router.post("/tasks/{task_id}/subtitles/search")
async def mixer_search_subtitles(
    task_id: str,
    req: SubtitleSearchRequest | None = None,
    _key: str = Depends(verify_api_key),
):
    """S6/T6: search OpenSubtitles for the `.srt` extraction could not give.

    Targets are the plan entries still `missing`/`not_extractable`/`failed`
    (optionally narrowed by `languages`); each one is searched on its own and
    the FIRST candidate is downloaded into the same sidecar naming the mux
    output would produce, flipping the entry to `downloaded`. Without an API
    key configured this answers 400 BEFORE any search. Entries are mutated in
    place on the live task (the cancel/pause pattern), so GET /tasks/:id shows
    the new statuses.
    """
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    api_key = get_setting("services", "opensubtitles", "api_key") or ""
    if not api_key:
        raise HTTPException(status_code=400, detail={"error": "opensubtitles_not_configured"})

    wanted = set(req.languages) if req and req.languages else None
    live = mux_tasks.get(task_id) or task
    targets = [
        entry
        for entry in (live.get("subtitles") or [])
        if entry.get("status") in _SEARCHABLE_STATUSES
        and (wanted is None or entry.get("language_code") in wanted)
    ]

    output_path = task.get("output_path") or ""
    query = _title_from_output_path(output_path) if output_path else ""
    results: list[dict] = []
    for entry in targets:
        if not output_path:
            entry["detail"] = "no_output_path"
        else:
            try:
                entry.update(await asyncio.to_thread(
                    _fetch_sidecar, api_key, query, entry["language_code"], output_path,
                ))
            except OpenSubtitlesError as exc:
                # One entry's failure never stops the rest (S6: los mismos
                # idiomas de audio — cada idioma se busca por separado).
                entry["detail"] = str(exc)[:200]
        result = {
            "language": entry["language"],
            "language_code": entry["language_code"],
            "status": entry["status"],
        }
        if entry.get("sidecar"):
            result["sidecar"] = entry["sidecar"]
        if entry.get("detail"):
            result["detail"] = entry["detail"]
        results.append(result)

    return {"ok": True, "results": results}
