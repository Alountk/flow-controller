"""Compatibility alias — the implementation lives in ``interfaces.http.routes_mixer``.

Aliased, not re-exported, so a patch by module path reaches the one
implementation. See `routes/__init__.py` for why the difference matters.

Delete this file once nothing imports it.
"""

from __future__ import annotations

import sys

from interfaces.http import routes_mixer as _impl

sys.modules[__name__] = _impl
