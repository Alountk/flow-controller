"""Walk a folder tree for the wanted scanner — the enumeration, not the judgement.

Behind `application.ports.ScanWalk`: which files are videos, how closely a
name matches a wanted title and which candidate wins is the use case's policy
(`application.use_cases.scan_wanted`); this adapter only yields the tree, so
`os.walk` stops being a route's syscall and becomes an injected fact.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

#: (root, dirs, files) per directory — os.walk's shape, minus its decisions.
TreeEntry = tuple[str, list[str], list[str]]


def walk(target: str) -> Iterator[TreeEntry]:
    """Depth-first over `target`, yielding (root, dirs, files) per directory."""
    yield from os.walk(target)
