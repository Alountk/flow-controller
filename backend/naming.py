"""Compatibility shim — the implementation lives in ``domain.naming``.

Naming is pure policy: rules and value objects over strings, with no I/O and no
dependency but the standard library. That is exactly what ``domain`` is for, so
it moved there.

This module only keeps the old import path working. Delete it once nothing
imports it; until then `tests_architecture.py` counts the implementation's
lines as migrated and this file's three as the remaining debt.
"""

from __future__ import annotations

from domain.naming import (  # noqa: F401
    MEDIA_EXTENSIONS,
    build_values,
    clean_title,
    evaluate,
    reproduced_radarr,
)

__all__ = [
    "MEDIA_EXTENSIONS",
    "build_values",
    "clean_title",
    "evaluate",
    "reproduced_radarr",
]
