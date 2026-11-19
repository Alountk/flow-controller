"""Measure a download with ffprobe before copying it to a folder that may not fit."""

from __future__ import annotations

import asyncio
from pathlib import Path

from domain import destination_fit
from domain.media_info import resolution as probed_resolution

VIDEO_EXTENSIONS = {".mkv", ".mp4", ".avi", ".m4v", ".mov", ".ts", ".wmv"}


def _main_video(src: Path) -> Path | None:
    if src.is_file():
        return src
    if not src.is_dir():
        return None
    videos = [p for p in src.rglob("*") if p.suffix.lower() in VIDEO_EXTENSIONS and p.is_file()]
    return max(videos, key=lambda p: p.stat().st_size, default=None)


async def check(src: str, dest: str, *, path_4k: str, path_3d: str, probe, library_root=None) -> dict | None:
    """A mismatch description, or None when the file fits (or cannot be judged).

    `library_root` is an async callable giving the folder a non-4K file belongs
    in; it is only awaited when that is the suggestion.
    """
    video = await asyncio.to_thread(_main_video, Path(src))
    if video is None:
        return None
    try:
        measured = probed_resolution(await asyncio.to_thread(probe, str(video)))
    except Exception:
        return None
    belongs = destination_fit.misfit(measured, destination_fit.role_of(dest, path_4k, path_3d))
    if not belongs:
        return None
    suggested = path_4k if belongs == "4k" else (await library_root() if library_root else "")
    return {"file": video.name, "resolution": measured, "destination": dest, "suggested": suggested or ""}

