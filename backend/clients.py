"""Compatibility alias — the implementation lives in ``infrastructure.arr_client``.

Radarr, Sonarr, qBittorrent and aMule all speak HTTP and JSON to us, and this
is the only place that knows how. That is an adapter by any definition: nothing
interesting about the app is downstream of it. It moved to ``infrastructure`` so
the day can come when the routes speak to a port instead of to this.

This file does NOT re-export names. It aliases the module object:

    sys.modules[__name__] = _impl   # so `clients` IS `arr_client`

The difference is not cosmetic. Tests patch by module path —
``patch("clients.arr_command")``, ``monkeypatch.setattr(clients, "os", ...)`` —
and with a re-export those land on a copy of the binding while the
implementation keeps calling its own. Verified side by side:

    re-export  patch("old_shim.VALUE")  ->  impl.VALUE stays 1   (silent no-op)
    alias      patch("old.VALUE")       ->  impl.VALUE becomes 99

A shim that quietly disconnects a test's patch is worse than no shim: the test
stays green and proves nothing. Delete this file once nothing imports it.
"""

from __future__ import annotations

import sys

from infrastructure import arr_client as _impl

sys.modules[__name__] = _impl
