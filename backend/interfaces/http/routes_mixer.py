"""Media Mixer API routes for flow-controller.

Provides endpoints for probing media files, muxing audio/video tracks,
and managing mux tasks (list, status, cancel, pause, resume).
"""
import asyncio
import logging
import os
import re

import aiohttp
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
from application.gateways import (
    arr_movie_exists,
    arr_movie_file,
    arr_movie_lookup,
    download_subtitle,
    get_setting,
    search_subtitles,
)
from application.ports import OpenSubtitlesError
from application.use_cases import downloads_cache
from application.use_cases.scan_wanted import normalize_title
from config import find_service, service_unavailable_reason
from interfaces.http.deps import verify_api_key
from state import http_session
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
    # L24: [{path, track_index, language}] — pistas `und` que el usuario marcó
    # como castellano (u otro idioma ordenado) para pasar el gate de exigidos.
    language_overrides: list[dict] = []


class SubtitleSearchRequest(BaseModel):
    languages: list[str] | None = None


class LookupRequest(BaseModel):
    filename: str = ""


class AlternativeLookupRequest(BaseModel):
    path: str = ""


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


def _resolve_language_overrides(
    probes: list[dict], overrides: list[dict] | None
) -> dict[tuple[str, int], str]:
    """L24: user-marked `und` tracks → effective language for this mux.

    «deberiamos poder marcar las pista und si son las castellanas para poder
    pasar el flag» — each override is `{path, track_index, language}`: the path
    must be one of the probed files, the ordinal must exist inside it, the
    track must probe as `und`, and the target language must normalize to one
    of `ORDERED_AUDIO_LANGUAGES`. Anything else raises 400
    `invalid_language_override` — the gate never guesses. Only the multi-file
    gate path resolves them (a single-file mux runs no gate and no plan).
    """
    if not overrides:
        return {}
    by_path = {os.path.realpath(p.get("path", "")): p for p in probes}
    resolved: dict[tuple[str, int], str] = {}
    for item in overrides:
        code = normalize_language(str(item.get("language", "")))
        if code not in ORDERED_AUDIO_LANGUAGES:
            raise HTTPException(
                status_code=400,
                detail=f"invalid_language_override: unknown language {item.get('language')!r}",
            )
        path = os.path.realpath(str(item.get("path", "")))
        probe = by_path.get(path)
        if probe is None:
            raise HTTPException(
                status_code=400,
                detail="invalid_language_override: path is not one of the probed files",
            )
        ordinal = item.get("track_index")
        tracks = probe.get("audio_tracks", [])
        if not isinstance(ordinal, int) or not 0 <= ordinal < len(tracks):
            raise HTTPException(
                status_code=400,
                detail="invalid_language_override: track_index out of range",
            )
        if normalize_language(tracks[ordinal].get("language", "und")) != "und":
            raise HTTPException(
                status_code=400,
                detail="invalid_language_override: target track is not und",
            )
        resolved[(path, ordinal)] = code
    return resolved


def _build_subtitle_plan(
    probes: list[dict], overrides: dict[tuple[str, int], str] | None = None
) -> list[dict]:
    """S6: one `.srt` sidecar plan entry per audio language of the files.

    «los mismos idiomas de audio» — the union of all audio languages. For
    each language at most ONE subtitle track is picked (extractable beats
    bitmap/unknown across files, then first file, first track); languages
    with no track still get an entry (T6 fills those via OpenSubtitles).
    Entries start `pending`; the background run resolves them.

    L24: `overrides` swaps a marked `und` audio track for its declared
    language (spa counts in the union; the plan entry is then `spa`).
    """
    overrides = overrides or {}

    def _rank(code: str) -> tuple[int, int | str]:
        if code in ORDERED_AUDIO_LANGUAGES:
            return (0, ORDERED_AUDIO_LANGUAGES.index(code))
        return (1, code)

    audio_langs = {
        overrides.get(
            (os.path.realpath(probe.get("path", "")), ordinal),
            normalize_language(track.get("language", "und")),
        )
        for probe in probes
        for ordinal, track in enumerate(probe.get("audio_tracks", []))
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


#: S7 release tags: everything from the first one on is scene noise. Word-ish
#: boundaries so `aac` never cuts a title like "Aachen"; the `.` before the
#: `1` of `DD5.1` may already be a space (dots become spaces below), hence
#: `[.\s]?` rather than a bare `\.?`.
_RELEASE_TAG_RE = re.compile(
    r"\b(?:2160p|1080p|720p|x26[45]|h26[45]|hevc|web-?dl|webrip|bluray|bdrip|hdtv|dts|aac|ddp?5?[.\s]?1)\b",
    re.IGNORECASE,
)


def _title_from_filename(filename: str) -> str:
    """Lookup title parsed from a file name (S7).

    `Dune.Parte.Dos.2024.1080p.WEB-DL.x264.mkv` → `Dune Parte Dos 2024`:
    extension gone, dots/underscores as spaces, cut at the first release tag.
    A trailing year survives — `(YYYY)` or ` YYYY ` — because Radarr matches
    on it (unlike `normalize_title`, which drops years for fuzzy scoring).
    """
    stem = os.path.splitext(os.path.basename(filename))[0]
    stem = re.sub(r"[._]", " ", stem)
    stem = re.sub(r"\s+", " ", stem).strip()
    match = _RELEASE_TAG_RE.search(stem)
    if match:
        stem = stem[: match.start()]
    return re.sub(r"\s+", " ", stem).strip(" -")


def _ordered_audio_languages(probe: dict) -> list[str]:
    """Audio language codes of one probe: normalized, deduped, ordered (S10).

    «el modal recibe los idiomas de audio del otro archivo» (L28): the four
    ordered languages first (ca→en→ru→cat), anything else after in code
    order — the `_build_subtitle_plan` rank, for one file instead of a pair.
    """
    codes = {
        normalize_language(track.get("language") or "und")
        for track in probe.get("audio_tracks", [])
    }

    def _rank(code: str) -> tuple[int, int | str]:
        if code in ORDERED_AUDIO_LANGUAGES:
            return (0, ORDERED_AUDIO_LANGUAGES.index(code))
        return (1, code)

    return sorted(codes, key=_rank)


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


@router.post("/lookup")
async def mixer_lookup(req: LookupRequest, _key: str = Depends(verify_api_key)):
    """S7: filename → title → Radarr lookup → the modal-ready movie (or not).

    `movie` is non-null ONLY when the lookup resolves a movie that is already
    IN the Radarr library — the id `ReleaseSearchModal` needs to search its
    releases. A lookup with no hit (or a hit Radarr does not own) answers
    `movie: null`, which the UI turns into «añádela primero en Radarr».
    Radarr being unusable is a 502, never a silent "not in library".
    """
    filename = (req.filename or "").strip()
    if not filename:
        raise HTTPException(status_code=400, detail="filename is required")

    title = _title_from_filename(filename)
    if not title:
        raise HTTPException(status_code=400, detail=f"Cannot derive a title from: {filename}")

    service = find_service("radarr", "arr")
    if not service:
        raise HTTPException(status_code=502, detail=service_unavailable_reason("radarr", "arr"))

    try:
        async with http_session() as session:
            lookup = await arr_movie_lookup(session, service, title)
            movie = None
            tmdb_id = (lookup or {}).get("tmdbId", 0)
            if tmdb_id:
                existing_id = await arr_movie_exists(session, service, tmdb_id)
                if existing_id:
                    movie = {
                        "id": existing_id,
                        "title": (lookup or {}).get("title") or title,
                        "year": (lookup or {}).get("year"),
                        "source": "radarr",
                    }
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        raise HTTPException(status_code=502, detail=f"Radarr lookup failed: {exc}")

    return {"ok": True, "title": title, "movie": movie}


@router.post("/alternatives/lookup")
async def mixer_alternatives_lookup(
    req: AlternativeLookupRequest, _key: str = Depends(verify_api_key)
):
    """S10: file path → title + Radarr movie + the file's audio languages.

    The T7 lookup with the other slot's real file attached: the title still
    comes from `_title_from_filename` and `movie` is still non-null only when
    Radarr's library owns it. What the file itself adds is `audio_languages`
    (L28: search by the languages the slot already covers) — the probe runs
    through `asyncio.to_thread` because ffprobe is a 30 s subprocess and there
    is one event loop. A path ffprobe cannot read is 400 (the picker handed us
    bad input); Radarr being unusable is 502, never a silent "not in library".
    """
    path = (req.path or "").strip()
    if not path:
        raise HTTPException(status_code=400, detail="path is required")

    title = _title_from_filename(path)
    if not title:
        raise HTTPException(status_code=400, detail=f"Cannot derive a title from: {path}")

    try:
        probe = await asyncio.to_thread(probe_file, path)
    except (FileNotFoundError, RuntimeError) as exc:
        # T11 maps a failed probe to 400 here: for THIS endpoint an unreadable
        # file is bad input (the /probe route maps RuntimeError to 500; the
        # alternatives contract enumerates 400 for «ffprobe falla»).
        raise HTTPException(status_code=400, detail=str(exc))

    audio_languages = _ordered_audio_languages(probe)

    service = find_service("radarr", "arr")
    if not service:
        raise HTTPException(status_code=502, detail=service_unavailable_reason("radarr", "arr"))

    try:
        async with http_session() as session:
            lookup = await arr_movie_lookup(session, service, title)
            movie = None
            tmdb_id = (lookup or {}).get("tmdbId", 0)
            if tmdb_id:
                existing_id = await arr_movie_exists(session, service, tmdb_id)
                if existing_id:
                    movie = {
                        "id": existing_id,
                        "title": (lookup or {}).get("title") or title,
                        "year": (lookup or {}).get("year"),
                        "source": "radarr",
                    }
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        raise HTTPException(status_code=502, detail=f"Radarr lookup failed: {exc}")

    return {"ok": True, "title": title, "movie": movie, "audio_languages": audio_languages}


@router.get("/alternatives/status")
async def mixer_alternatives_status(
    movie_id: int = 0, title: str = "", _key: str = Depends(verify_api_key)
):
    """S10: where the alternative stands — `ready` | `downloading` | `unknown`.

    1. `ready` — Radarr already holds the file (`arr_movie_file`); `path` is
       its absolute location and `allowed` says whether the app may place it
       (`config.path_is_allowed`), `progress` is null.
    2. `downloading` — no file yet, but a downloads row whose normalized title
       (`normalize_title` on BOTH sides, so dotted release names match too)
       contains the normalized title: its `progress`, null when unknowable.
    3. `unknown` — no file and no row. The UI keeps waiting; nothing times out.

    Radarr being unconfigured or unreachable is NOT an error here: without an
    answer there is simply no file to report, and the row check decides. The
    only 400s are the contract's own: `movie_id <= 0` or an empty `title`.
    """
    if movie_id <= 0:
        raise HTTPException(status_code=400, detail="movie_id must be a positive integer")
    if not (title or "").strip():
        raise HTTPException(status_code=400, detail="title is required")

    path = None
    service = find_service("radarr", "arr")
    if service:
        try:
            async with http_session() as session:
                path = await arr_movie_file(session, service, movie_id)
        except (aiohttp.ClientError, asyncio.TimeoutError):
            path = None
    if path:
        return {
            "state": "ready",
            "progress": None,
            "path": path,
            "allowed": config.path_is_allowed(path),
        }

    needle = normalize_title(title)
    try:
        snapshot = await downloads_cache.get_downloads()
    except Exception:  # noqa: BLE001 — no snapshot to serve reads as "no row": unknown
        snapshot = {}
    rows = (snapshot or {}).get("downloads") or []
    row = next(
        (
            item
            for item in rows
            if needle and needle in normalize_title(str(item.get("title") or ""))
        ),
        None,
    )
    if row is not None:
        progress = row.get("progress")
        return {
            "state": "downloading",
            "progress": progress if isinstance(progress, (int, float)) else None,
            "path": None,
            "allowed": False,
        }
    return {"state": "unknown", "progress": None, "path": None, "allowed": False}


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
        # files carrying the language is enough). L24: `language_overrides`
        # counts a user-marked `und` track as its declared language.
        overrides_map = _resolve_language_overrides(list(probes), req.language_overrides)
        required = _required_languages()
        available = {
            overrides_map.get(
                (os.path.realpath(probe.get("path", "")), ordinal),
                normalize_language(track.get("language", "und")),
            )
            for probe in probes
            for ordinal, track in enumerate(probe.get("audio_tracks", []))
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
        subtitle_plan = _build_subtitle_plan(list(probes), overrides_map)

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
