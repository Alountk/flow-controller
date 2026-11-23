"""aMule's own download rows in the qBittorrent-shaped dict the traces read.

Traces were written against a qBittorrent-style client list. aMule is now read
directly, so this is the one place that translates its rows into that shape.
"""

from __future__ import annotations

_STATE = {"completed": "uploading", "paused": "pausedDL", "downloading": "downloading", "waiting": "stalledDL"}


def from_row(row: dict, categories: dict[int, str], save_path: str) -> dict:
    size = row.get("size_full") or 0
    return {
        "hash": (row.get("hash") or "").lower(),
        "name": row.get("name") or "",
        "state": _STATE.get(row.get("state"), "stalledDL"),
        "progress": min(1.0, (row.get("size_done") or 0) / size) if size else 0,
        "dlspeed": row.get("speed") or 0,
        "eta": row.get("eta_seconds"),
        "size": size,
        "category": categories.get(row["category"]) if row.get("category") is not None else None,
        "save_path": save_path,
        "num_seeds": row.get("sources"),
        "source": "amule",
    }


def completed(name: str, save_path: str, client_hash: str = "") -> dict:
    """A download aMule already moved out of its queue: only the disk remembers it."""
    return {
        "hash": (client_hash or "").lower() or f"amule:{name}",
        "name": name,
        "state": "uploading",
        "progress": 1.0,
        "dlspeed": 0,
        "eta": None,
        "size": None,
        "category": None,
        "save_path": save_path,
        "num_seeds": None,
        "source": "amule",
    }
