"""Which library files sit below the quality threshold («umbral-calidad» S4).

Pure on purpose: files and a cache reader in, a report out. Everything that
knows about sqlite or Radarr is the caller's business, which is what makes the
honesty rule testable — a file nobody analyzed is COUNTED apart, never listed
as low quality.
"""

from __future__ import annotations

import os
from typing import Callable

from domain.quality import is_below_threshold, resolution_class


def _measured(probe: dict) -> dict:
    """The chosen video track's measurements, or empty when the probe has none."""
    tracks = probe.get("video_tracks") or []
    track = next((t for t in tracks if t.get("selected")), tracks[0] if tracks else None)
    return track or {}


def build(
    files: list[str],
    *,
    cache_get: Callable[[str], dict | None],
    min_class: str = "1080p",
    min_width: int = 0,
) -> dict:
    """Report of every measured file below `min_class`/`min_width`.

    `items` carries only files with a FRESH persisted probe: the list can only
    claim what was measured. `unanalyzed` counts the rest, so "no candidates"
    never hides a library nobody swept.
    """
    items: list[dict] = []
    analyzed = 0
    unanalyzed = 0

    for path in files:
        probe = cache_get(path)
        if not probe:
            unanalyzed += 1
            continue
        analyzed += 1
        track = _measured(probe)
        width = int(track.get("width") or 0)
        height = int(track.get("height") or 0)
        if not is_below_threshold(width, height, min_class=min_class, min_width=min_width):
            continue
        items.append({
            "path": path,
            "name": os.path.basename(path),
            "width": width,
            "height": height,
            "class": resolution_class(width, height),
            "size_bytes": int(probe.get("size_bytes") or 0),
            "duration": float(probe.get("duration") or 0),
        })

    items.sort(key=lambda item: (item["class"], item["name"]))
    return {
        "threshold": {"min_class": min_class, "min_width": min_width},
        "items": items,
        "analyzed": analyzed,
        "unanalyzed": unanalyzed,
    }
