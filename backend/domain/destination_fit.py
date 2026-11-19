"""Does a measured resolution belong in this destination folder?

Only the two certain cases are judged: a 2160 file outside the 4K folder, and a
non-2160 file inside it. Anything else (3D folders, unmeasured files) passes.
"""

from __future__ import annotations


def _under(path: str, root: str) -> bool:
    root = root.rstrip("/")
    return bool(root) and (path == root or path.startswith(root + "/"))


def role_of(path: str, path_4k: str, path_3d: str) -> str:
    if _under(path, path_4k):
        return "4k"
    if _under(path, path_3d):
        return "3d"
    return "library"


def misfit(resolution: str, role: str) -> str:
    """The role the file belongs to when it differs from `role`, else `""`."""
    if not resolution or role == "3d":
        return ""
    belongs = "4k" if resolution == "2160" else "library"
    return belongs if belongs != role else ""
