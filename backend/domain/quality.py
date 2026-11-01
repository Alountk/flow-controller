"""Where a release lands, decided from what it is.

Pure: a quality string, a 3D flag and two configured folders in, a folder out.
No configuration, no filesystem, no service. The callers that know about those
things pass them in, which is what makes the rule testable on its own and what
keeps it from quietly growing a dependency on a deployment.
"""

from __future__ import annotations


def destination_for_quality(
    quality: str,
    *,
    is3d: bool = False,
    path_4k: str = "",
    path_3d: str = "",
) -> str | None:
    """Folder a release should land in; None means the arr's library.

    Radarr reports the quality as one hyphen-joined token — ``Bluray-2160p``,
    ``WEBDL-2160p``, ``HDTV-2160p`` — so the resolution is matched on its
    suffix, which is what actually distinguishes the classes; the container
    varies and the number does not.

    **3D outranks the resolution.** A 3D rip is 3D whatever it was encoded at,
    so keying it off resolution would scatter the 3D collection across two
    destinations based on a property nobody picked. The cost of the other
    order — a 4K3D title sitting in the 3D folder — keeps the 3D collection
    whole, which is the entire reason that folder exists.

    `is3d` arrives already resolved: unlike a quality, "is this 3D?" is an
    interpretation of the title plus a human correction, so the caller decides
    and this function only routes.

    An unconfigured folder resolves to None, so adding this never changes a
    deployment that has not opted in. It is deliberately NOT authoritative:
    an explicit destination from the caller wins, because a folder chosen by
    hand is a decision and a quality is only a hint.
    """
    if is3d and path_3d:
        return path_3d
    name = (quality or "").strip().lower()
    if name.endswith("2160p") and path_4k:
        return path_4k
    return None


# ── Resolution class («umbral-calidad» S1) ───────────────────────────────────
#
# The class comes from the WIDTH on purpose: a 1080p transfer with its black
# bars cropped measures 1920×800, and keying off the bare height would call
# every widescreen movie low quality.
_CLASS_RANK = {"desconocido": 0, "sd": 1, "720p": 2, "1080p": 3, "4k": 4}

#: Widths, not heights: 1100-1699 is a 720p-class file, 1700 and up is at
#: least 1080p (so 2560-wide counts as 1080p+, never as low quality), 3000+
#: is 4K. Heights are deliberately unused — see the module comment.
_CLASS_WIDTH_FLOOR = (("4k", 3000), ("1080p", 1700), ("720p", 1100))


def resolution_class(width: int | None, height: int | None = None) -> str:
    """Measured resolution class: «4k» | «1080p» | «720p» | «sd» | «desconocido».

    `height` is accepted so callers can pass the probe verbatim; it never
    changes the answer (cropped bars are not a downgrade).
    """
    if not width or width <= 0:
        return "desconocido"
    for name, floor in _CLASS_WIDTH_FLOOR:
        if width >= floor:
            return name
    return "sd"


def class_rank(name: str | None) -> int:
    """Ordering for comparisons; anything unknown sinks below `sd` (never low)."""
    return _CLASS_RANK.get((name or "").strip().lower(), 0)


def is_below_threshold(
    width: int | None,
    height: int | None = None,
    *,
    min_class: str = "1080p",
    min_width: int = 0,
) -> bool:
    """Whether a measured file sits below the configured quality threshold.

    `min_width > 0` overrides the class comparison (the manual field); an
    unmeasured file is never "below" anything — it is not analyzed yet.
    """
    measured = resolution_class(width, height)
    if measured == "desconocido":
        return False
    if min_width and min_width > 0:
        return (width or 0) < min_width
    return class_rank(measured) < class_rank(min_class)
