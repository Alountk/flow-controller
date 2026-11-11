"""Which class a movie belongs to, in the vocabulary the V2 list shows.

Pure: what Radarr reports about the file (its flag, its quality, its path), what
the disk listed and the configured 3D folder in, one label out. No config, no
disk, no network — the caller that owns the disk passes what it listed, which is
what keeps the rule testable and the chips honest.

The five buckets are exclusive and cover the whole catalogue, because the
header counts them and their sum must be the total. `sin archivo` wins over any
quality Radarr still remembers: the chip answers "what is not here".
"""

from __future__ import annotations

from typing import Iterable, Mapping

from domain.naming import MEDIA_EXTENSIONS
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


def _is_video(name: str) -> bool:
    """True when a listing entry is a video file. A sidecar named `1080p.srt`
    must never light a chip its video never earned."""
    dot = name.rfind(".")
    return dot > 0 and name[dot:].lower() in MEDIA_EXTENSIONS


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


def _folder_labels(
    *,
    has_file: bool,
    quality: str,
    path: str = "",
    path_3d: str = "",
    resolution: str = "",
    file_name: str = "",
    folder_files: Iterable[str] = (),
) -> dict[str, str]:
    """The movie's own folder, classified: `label -> the file that earns it`.

    The file Radarr owns (matched through `file_name`, its probe beating its
    name) wins its label over any other candidate; the rest are first-listed.
    """
    if not has_file:
        return {}
    by_label: dict[str, str] = {}
    own = file_name.replace("\\", "/").rsplit("/", 1)[-1]
    for name in folder_files:
        if not _is_video(name):
            continue
        is_own = bool(own) and name == own
        if is_own:
            # The file Radarr owns: its probe beats its name (the John Wick
            # rule), and the probe stops at this one file.
            cls = library_class(
                has_file=True, quality=quality, path=path, path_3d=path_3d, resolution=resolution
            )
        else:
            cls = library_class(has_file=True, quality=name, path=path, path_3d=path_3d)
        label = _CLASS_RESOLUTION.get(cls)
        if not label:
            continue
        if is_own:
            by_label[label] = name  # the own file wins its label over any other
        else:
            by_label.setdefault(label, name)
    return by_label


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
    file_name: str = "",
    folder_files: Iterable[str] = (),
) -> list[str]:
    """The resolutions a row lights: what the DISK proves, in chip order.

    S1: a chip lights only when a physical file of that class is linked. The
    movie's own folder proves its files (`folder_files`, the names listed on
    disk); the copies prove the rest. An empty iterable — an unconfigured
    folder, an unreadable one — proves nothing, which is not the same as
    proving absence: Radarr's `quality` alone lights nothing.

    The file Radarr adopted keeps its probe (`best(resolution, quality)` beats
    the name) and is matched to its disk entry through `file_name`; every other
    entry is classified by its name alone. The probe stops at that one file: a
    leftover named `720p` is SD even when the movieFile measures 1080.

    `copies_4k`/`copies_3d` are the children of each configured root, read once
    by whoever owns the disk.
    """
    if not has_file:
        return []
    folder = path.rstrip("/").split("/")[-1] if path else ""
    have = set(
        _folder_labels(
            has_file=has_file,
            quality=quality,
            path=path,
            path_3d=path_3d,
            resolution=resolution,
            file_name=file_name,
            folder_files=folder_files,
        )
    )
    if _in_folder(path, path_4k) or any(_copy_matches(folder, c) for c in copies_4k):
        have.add("4K")
    if _in_folder(path, path_3d) or any(_copy_matches(folder, c) for c in copies_3d):
        have.add("3D")
    return [label for label in RESOLUTIONS if label in have]


def own_1080_file(
    *,
    has_file: bool,
    quality: str,
    path: str = "",
    path_3d: str = "",
    resolution: str = "",
    file_name: str = "",
    folder_files: Iterable[str] = (),
) -> str:
    """The name of the folder's 1080 file, or `""` when there is none.

    S2's presented file, 1080-o-nada: the movieFile wins the 1080 slot when it
    IS the 1080 file; otherwise any 1080-class video in the folder qualifies.
    """
    return _folder_labels(
        has_file=has_file,
        quality=quality,
        path=path,
        path_3d=path_3d,
        resolution=resolution,
        file_name=file_name,
        folder_files=folder_files,
    ).get("1080p", "")


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
