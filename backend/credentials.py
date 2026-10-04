"""Compatibility alias — the implementation lives in ``infrastructure.credentials``.

The settings file is how this deployment is told what it is: which services
exist, where the libraries are, what is allowed. Reading and writing that file
is I/O; what the settings MEAN is decided elsewhere.

same pattern as clients.py and history.py: aliased so a patch by module path reaches the one implementation.

Aliased rather than re-exported (`sys.modules[__name__] = _impl`) so `import x`,
`from x import y` and `patch("x.y")` all reach the one implementation.

Delete this file once nothing imports it.
"""

from __future__ import annotations

import sys

from infrastructure import credentials as _impl

sys.modules[__name__] = _impl
