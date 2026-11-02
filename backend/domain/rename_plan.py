"""The names a rename may produce, and the files that travel with the video.

Pure on purpose: the dialog's whole risk is a name that becomes a path, so the
deciding is testable here and the touching stays a thin layer elsewhere.

A sidecar is not "a file that looks related": it is the video's base name
followed by a dot or a dash and an extension somebody actually writes next to a
video (SRT, NFO, thumb). Anything else in the folder belongs to another file.
"""

from __future__ import annotations

from pathlib import PurePosixPath
from typing import Iterable

from domain.naming import MEDIA_EXTENSIONS

#: Extensions that live *next to* a video rather than being one. A `.json` or a
#: second `.mkv` sharing the stem is not a sidecar, so the list stays closed.
SIDECAR_EXTENSIONS = frozenset(
    {".srt", ".sub", ".idx", ".ass", ".ssa", ".vtt", ".sup", ".nfo", ".jpg", ".jpeg", ".png"}
)

#: The longest name a filesystem is expected to accept, in characters.
MAX_NAME = 255


def base_name(name: str) -> str:
    """`Alien.1979.1080p.mkv` -> `Alien.1979.1080p`; non-media names untouched."""
    candidate = PurePosixPath(str(name).replace("\\", "/")).name
    path = PurePosixPath(candidate)
    if path.suffix.lower() in MEDIA_EXTENSIONS:
        return path.stem
    return candidate


def _extension(name: str) -> str:
    return PurePosixPath(name).suffix.lower()


def is_sidecar_of(name: str, video_name: str) -> bool:
    """Whether `name` is a sidecar of the video — same base, dot or dash, known ext."""
    base = base_name(video_name)
    if not base or name == video_name or not name.startswith(base):
        return False
    rest = name[len(base) :]
    if not rest or rest[0] not in ".-":
        return False
    return _extension(name) in SIDECAR_EXTENSIONS


def sidecars(video_name: str, siblings: Iterable[str]) -> list[str]:
    """The siblings that follow the video, in the order the folder listed them."""
    return [n for n in siblings if is_sidecar_of(n, video_name)]


def sidecar_target(video_name: str, sidecar_name: str, new_stem: str) -> str:
    """Where a sidecar goes, keeping the suffix that tells it apart (`-thumb`, `.es`)."""
    rest = sidecar_name[len(base_name(video_name)) :]
    return f"{new_stem}{rest}"


def _clean(name: str) -> str | None:
    value = (name or "").strip()
    if not value or value in {".", ".."} or value.startswith("."):
        return None
    if len(value) > MAX_NAME:
        return None
    if any(ch in value for ch in "/\\") or any(ord(ch) < 32 for ch in value):
        return None
    return value


def folder_name(name: str) -> str | None:
    """The folder to create, or None when the typed name cannot be one."""
    return _clean(name)


def file_stem(name: str) -> str | None:
    """The file name without extension, or None when the typed name cannot be one."""
    value = _clean(name)
    if value is None or _extension(value) in MEDIA_EXTENSIONS:
        return None
    return value
