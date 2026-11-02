"""Which class a movie belongs to, in the vocabulary the V2 list shows.

Pure: what Radarr reports about the file (its flag, its quality, its path) and
the configured 3D folder in, one label out. No config, no disk, no network —
the caller that knows the deployment passes the folder, which is what keeps the
rule testable and the chips honest.

The five buckets are exclusive and cover the whole catalogue, because the
header counts them and their sum must be the total. `sin archivo` wins over any
quality Radarr still remembers: the chip answers "what is not here".
"""

from __future__ import annotations

from typing import Iterable, Mapping

#: Order of the chips' counts; `todos` is the total, not a class.
CLASSES = ("sin archivo", "4K", "3D", "1080", "otros")


def _in_folder(path: str, folder: str) -> bool:
    """True when `path` is `folder` or lives under it. An unconfigured folder
    ("") matches nothing — empty means "not configured", never "everything"."""
    if not path or not folder:
        return False
    root = folder.rstrip("/")
    return path == root or path.startswith(f"{root}/")


def library_class(
    *,
    has_file: bool,
    quality: str,
    path: str = "",
    path_3d: str = "",
) -> str:
    """The class of one movie: one of `CLASSES`.

    `3D` outranks the resolution, exactly as it does when routing a release: a
    3D rip is 3D whatever it was encoded at, and the folder a human picked for
    it is a decision while the resolution is only a property.
    """
    if not has_file:
        return "sin archivo"
    if _in_folder(path, path_3d):
        return "3D"
    name = (quality or "").strip().lower()
    if "2160p" in name:
        return "4K"
    if "1080p" in name:
        return "1080"
    return "otros"


def class_counts(
    items: Iterable[Mapping[str, object]], *, path_3d: str = ""
) -> dict[str, int]:
    """The chips' counts over a whole catalogue, `todos` first."""
    counts = {"todos": 0, **{cls: 0 for cls in CLASSES}}
    for item in items:
        counts["todos"] += 1
        counts[
            library_class(
                has_file=bool(item.get("has_file")),
                quality=str(item.get("quality") or ""),
                path=str(item.get("path") or ""),
                path_3d=path_3d,
            )
        ] += 1
    return counts
