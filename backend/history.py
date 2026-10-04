"""Compatibility alias — the implementation lives in ``infrastructure.sqlite_history``.

Everything durable this app knows is a row here: what we grabbed, what we
decided about it, what was copied and when. SQLite is a detail of how that is
kept; the fact of keeping it is application behaviour.

Aliased, not re-exported, for the reason spelled out in ``clients.py``: tests
patch by module path, and a re-export hands them a copy of the binding while
the implementation keeps using its own. `history` IS `sqlite_history`.

Delete this file once nothing imports it.
"""

from __future__ import annotations

import sys

from infrastructure import sqlite_history as _impl

sys.modules[__name__] = _impl
