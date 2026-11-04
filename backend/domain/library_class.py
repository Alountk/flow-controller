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

from domain.resolution import best

#: Order of the chips' counts; `todos` is the total, not a class.
CLASSES = ("sin archivo", "4K", "3D", "1080", "SD", "otros")

#: Order of one row's resolution chips — the design's, verbatim.
RESOLUTIONS = ("4K", "3D", "1080p", "SD")

#: The class each label maps to. `sin archivo` maps to nothing on purpose: a
#: movie with no file lights no resolution, not even the one it used to have.
_CLASS_RESOLUTION = {"4K": "4K", "3D": "3D", "1080": "1080p", "SD": "SD"}


#: Measured class -> bucket. `SD` is what a measurement or a name places BELOW
#: 1080; `otros` is what proves nothing at all, which is not the same claim.
_PROBED_CLASS = {"2160": "4K", "1080": "1080", "720": "SD", "576": "SD", "480": "SD"}


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
    resolution: str = "",
) -> str:
    """The class of one movie: one of `CLASSES`.

    `3D` outranks the resolution, exactly as it does when routing a release: a
    3D rip is 3D whatever it was encoded at, and the folder a human picked for
    it is a decision while the resolution is only a property.

    `resolution` is the MEASURED class (`"2160"`, `"1080"`, `"720"`…). The
    measurement wins and the name is the fallback — `domain.resolution.best`
    holds that precedence, and this function only maps it to the list's buckets.
    """
    if not has_file:
        return "sin archivo"
    if _in_folder(path, path_3d):
        return "3D"
    return _PROBED_CLASS.get(best(resolution, quality), "otros")


def _copy_matches(folder: str, child: str) -> bool:
    """True when `child` is a folder of `folder`'s movie.

    Copies keep the movie folder at the FRONT and add their own marker
    (`Alien (1979) [4K]`), so the prefix is the proof — but an unbroken prefix is
    not: `Aliens (1986)` starts with `Alien` and is another movie. The character
    after the prefix has to close the name or open a marker.
    """
    if not folder or not child:
        return False
    if child == folder:
        return True
    if not child.startswith(folder):
        return False
    return child[len(folder)] in " -_.[("


def available_resolutions(
    *,
    has_file: bool,
    quality: str,
    path: str = "",
    path_4k: str = "",
    path_3d: str = "",
    copies_4k: Iterable[str] = (),
    copies_3d: Iterable[str] = (),
    resolution: str = "",
) -> list[str]:
    """The resolutions a row lights: what the disk proves, in chip order.

    The movie's own file proves its class; the copies prove the rest. That
    second half is the whole point: a movie lives in ONE folder, so its own path
    can never be inside the 4K root and the 3D root at the same time, and a
    library that keeps a 1080 copy plus a 4K remux would show only one of them.

    `copies_4k`/`copies_3d` are the children of each configured root, read once
    by whoever owns the disk. An empty iterable — an unconfigured folder, an
    unreadable one — proves nothing, which is not the same as proving absence.
    """
    if not has_file:
        return []
    folder = path.rstrip("/").split("/")[-1] if path else ""
    have: set[str] = set()
    own = _CLASS_RESOLUTION.get(
        library_class(
            has_file=has_file,
            quality=quality,
            path=path,
            path_3d=path_3d,
            resolution=resolution,
        )
    )
    if own:
        have.add(own)
    if _in_folder(path, path_4k) or any(_copy_matches(folder, c) for c in copies_4k):
        have.add("4K")
    if _in_folder(path, path_3d) or any(_copy_matches(folder, c) for c in copies_3d):
        have.add("3D")
    return [label for label in RESOLUTIONS if label in have]


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
                resolution=str(item.get("resolution") or ""),
            )
        ] += 1
    return counts
