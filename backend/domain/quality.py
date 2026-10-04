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
