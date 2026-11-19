"""Wiring of the destination guard to the arr and the probe, for the copy action."""

from __future__ import annotations

import config
from application.use_cases import destination_guard
from infrastructure.arr_client import arr_movie_root_folder
from media_mixer import probe_file


async def for_copy(output_path: str, dest: str, source: str, ids: dict, session, service) -> dict | None:
    """The `needs_confirmation` answer for a copy whose file does not fit `dest`."""
    async def library_root():
        if source == "radarr" and ids.get("movie_id"):
            return config.host_path(await arr_movie_root_folder(session, service, ids["movie_id"]) or "")
        return ""

    found = await destination_guard.check(
        config.host_path(output_path), config.host_path(dest), path_4k=config.host_path(config.PATH_4K),
        path_3d=config.host_path(config.PATH_3D), probe=probe_file, library_root=library_root,
    )
    return {"ok": False, "needs_confirmation": True, "mismatch": found} if found else None
