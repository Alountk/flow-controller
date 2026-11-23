"""What aMule is downloading, plus what it already finished, as client torrents."""

from __future__ import annotations

import asyncio
import logging
import os

import config
from domain import amule_torrent
from infrastructure.amule_service import amule_categories, amule_downloads

log = logging.getLogger("flow-controller")


def _read(finished: dict[str, str]) -> list[dict]:
    save_path = config.FOLDER_DOWNLOAD_AMULE
    rows = amule_downloads()
    names = {r.get("name") for r in rows}
    by_index = {index: title for title, index in amule_categories().items()}
    torrents = [amule_torrent.from_row(r, by_index, save_path) for r in rows]
    incoming = config.host_path(save_path)
    torrents.extend(
        amule_torrent.completed(name, save_path, client_hash)
        for name, client_hash in finished.items()
        if name not in names and os.path.exists(os.path.join(incoming, name))
    )
    return torrents


async def fetch_amule_torrents(finished: dict[str, str] | None = None) -> list[dict]:
    """`finished` maps a grab's client name to its hash: the downloads to look for on disk.

    A failed read is an empty list, as the old client call was: a trace page
    must not die because aMule is unreachable.
    """
    try:
        return await asyncio.to_thread(_read, finished or {})
    except Exception as exc:
        log.warning("amule torrents: no disponibles: %s", exc)
        return []
