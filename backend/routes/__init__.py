"""Compatibility alias — the implementation lives in ``interfaces.http.routes``.

Delivery. These modules parse a request, decide what the caller is allowed to
ask for, hand the work to something that does it, and shape the answer. That is
the outermost ring: nothing inside the app may know an HTTP request exists.

Aliased as a package (`sys.modules[__name__] = _impl`) rather than re-exported.
The swap alone is not quite enough: `routes.status` and
`interfaces.http.routes.status` would then load as two separate module objects
from the same file, and `patch("routes.status.router")` would patch one while
the app mounted the other. So the submodules are imported once and registered
under both names below.

Delete this package once nothing imports it.
"""

from __future__ import annotations

import importlib
import sys

from interfaces.http import routes as _impl

sys.modules[__name__] = _impl

#: Every delivery module, registered under both names so there is one object.
#: Importing is a side effect of `import routes` on purpose — a second load is
#: exactly the bug this exists to prevent.
for _name in (
    "actions",
    "auto_copy",
    "calendar",
    "downloads",
    "files",
    "mediacover",
    "settings",
    "status",
    "wanted",
):
    _module = importlib.import_module(f"interfaces.http.routes.{_name}")
    sys.modules[f"routes.{_name}"] = _module
    sys.modules[f"interfaces.http.routes.{_name}"] = _module

del _name, _module
