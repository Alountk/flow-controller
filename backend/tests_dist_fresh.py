"""`frontend/dist` must be newer than the source it was built from.

Not a hypothetical: it went stale for SEVEN hours once. A session merged six
frontend PRs without rebuilding, the preview served `index-BwB9kETe.js` from
23:45 hours before, and three rounds of debugging spent time on "is the fix
even in the bundle?" — with a local runbook that says to rebuild after every
merge and no enforcement anywhere.

This is the enforcement. It runs with the ordinary backend suite, so it fails
in the place the project already looks, and it skips when there is no `dist`
to judge — which is the state of every CI checkout, because `dist/` is
gitignored and only `frontend-build` produces it.
"""

from __future__ import annotations

import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
SRC = REPO / "frontend" / "src"
DIST = REPO / "frontend" / "dist" / "index.html"


def _newest(mtime: float, root: pathlib.Path) -> pathlib.Path | None:
    """The file under `root` that would need rebuilding after a change."""
    newest = None
    for path in root.rglob("*"):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        if newest is None or path.stat().st_mtime > newest.stat().st_mtime:
            newest = path
    return newest


def test_the_build_is_newer_than_the_source():
    if not DIST.is_file():
        # CI has no dist — it is gitignored, and this job never builds it.
        # The check is for a preview running from a real checkout.
        return
    if not SRC.is_dir():
        return

    built = DIST.stat().st_mtime
    newest = _newest(built, SRC)
    assert newest is not None, f"{SRC} has no files to compare against"

    if newest.stat().st_mtime <= built:
        return

    changed = (newest.stat().st_mtime - built) / 60
    raise AssertionError(
        f"frontend/dist is {changed:.0f} minutes OLDER than {newest.relative_to(REPO)}.\n"
        "The preview is serving a bundle that predates the source.\n"
        "  cd frontend && npm run build\n"
        "This is the exact failure that once cost seven hours of debugging: the\n"
        "code was right, the shipped bundle was old, and nothing said so."
    )
