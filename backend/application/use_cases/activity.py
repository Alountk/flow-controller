"""Dashboard activity (Stitch 01, section 3): the recent-operations log and
the active-downloads snapshot, merged into one recency-ordered table.

Both sources degrade independently: a dead database or a failed arr fan-out
costs the missing half, never the whole table. States pass through RAW —
the labels belong to the frontend, which owns the vocabulary.
"""

import asyncio
import time

from application import gateways
from application.use_cases import downloads_cache

#: `arr_source` is only a service when it names one of ours — anything else
#: (a host, a typo) is not a label the UI can stand behind, and the item
#: reports no service rather than a foreign string.
_SERVICES = {"radarr", "sonarr", "amutorrent"}


def _operation_item(op: dict) -> dict:
    service = (op.get("arr_source") or "").strip().lower()
    return {
        "kind": "operation",
        # Recency of the row is when the operation was created — the same
        # key recent_operations orders by.
        "at": op.get("created_at") or 0.0,
        "service": service if service in _SERVICES else None,
        "name": op.get("name") or "",
        "destination": op.get("dst") or None,
        "size_bytes": op.get("size_bytes") or 0,
        "status": op.get("status") or "",
        "import_status": op.get("import_status") or "",
        "op_type": op.get("type") or "",
    }


def _download_item(download: dict, snapshot_at: float) -> dict:
    return {
        "kind": "download",
        # The snapshot has no per-item clock: it carries one honest `updated_at`
        # for every active download in it.
        "at": snapshot_at,
        "service": download.get("source") or None,
        "name": download.get("title") or "",
        # The snapshot never carries a destination — null, never a guess.
        "destination": None,
        "size_bytes": download.get("size") or 0,
        "status": download.get("status") or "",
        "import_status": "",
        "problem": bool(download.get("problem")),
        "op_type": "",
    }


async def get_activity(limit: int = 10) -> dict:
    """Newest-first activity rows, at most `limit` after the merge."""
    try:
        ops = await asyncio.to_thread(gateways.history.recent_operations, limit)
    except Exception:  # degrade-not-raise: the table shows the other half
        ops = []
    try:
        snapshot = await downloads_cache.get_downloads()
    except Exception:
        snapshot = {}

    items = [_operation_item(op) for op in ops]
    snapshot_at = snapshot.get("updated_at")
    for download in snapshot.get("downloads") or []:
        items.append(_download_item(download, snapshot_at or time.time()))

    items.sort(key=lambda item: item["at"], reverse=True)
    return {"items": items[:limit], "updated_at": time.time()}
