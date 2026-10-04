"""Compatibility alias — the implementation lives in ``infrastructure.settings_store``.

The settings file is how this deployment is told what it is: which services
exist, where the libraries are, what is allowed. Reading and writing that file
is I/O; what the settings MEAN is decided elsewhere.

every test that reconfigures it reaches for `settings.CONFIG_DIR`, `settings.SETTINGS_FILE` or `settings._settings` — a re-export would patch a copy while the store kept reading its own.

Aliased rather than re-exported (`sys.modules[__name__] = _impl`) so `import x`,
`from x import y` and `patch("x.y")` all reach the one implementation.

Delete this file once nothing imports it.
"""

from __future__ import annotations

import sys

from infrastructure import settings_store as _impl

sys.modules[__name__] = _impl
