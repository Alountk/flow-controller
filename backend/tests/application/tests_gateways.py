"""`application.gateways` hands delivery what it is — typed, checked at bind.

The surface used to resolve unknown names through a module-level
`__getattr__`, which made every binding invisible until a request reached for
it: `settings_store.encryption_error` is a module-level STRING, and a delegate
that wrapped it into a callable made the route return the callable.
`jsonable_encoder` rendered that as `{}`, React error #31 — objects are not
valid as a React child — tore the dashboard down behind ErrorBoundary, and
every single request stayed green.

Now the slots are typed attributes (`application.ports`), `bind` rejects an
adapter that does not satisfy its port, and a constant is read as an attribute
off the bound module (`gateways.settings.encryption_error`): a constant stays
a constant all the way to the response.
"""

from __future__ import annotations

from types import ModuleType

import pytest

from application import gateways
from application.ports import ArrClient, CredentialsStore, HistoryStore, SystemProbe, port_members


def _stand_in(port: type):
    """An object declaring every member of a runtime_checkable port."""
    class _Stand:
        pass

    obj = _Stand()
    for name in port_members(port):
        setattr(obj, name, lambda *args, **kwargs: None)
    return obj


def _fake_walk(_target):
    return iter(())


@pytest.fixture(autouse=True)
def _restore_the_real_adapters():
    """`bind` is module state. A fake left behind poisons every later test."""
    saved = (
        gateways._arr,
        gateways.settings,
        gateways.history,
        gateways.credentials,
        gateways.system,
        gateways.scan,
    )
    yield
    (
        gateways._arr,
        gateways.settings,
        gateways.history,
        gateways.credentials,
        gateways.system,
        gateways.scan,
    ) = saved


class _Settings:
    """A stand-in adapter: the live constant, plus the functions delivery calls."""

    encryption_error = "no se pudo descifrar"
    auth_required = staticmethod(lambda: True)
    get_settings = staticmethod(lambda: {})
    get_setting = staticmethod(lambda *args, **kwargs: None)
    save_settings = staticmethod(lambda data: True)


def _bind(arr=None, sqlite_history=None, credentials_module=None, system=None, scan=None):
    gateways.bind(
        arr=arr if arr is not None else _stand_in(ArrClient),
        settings=_Settings(),
        sqlite_history=sqlite_history if sqlite_history is not None else _stand_in(HistoryStore),
        credentials_module=(
            credentials_module if credentials_module is not None else _stand_in(CredentialsStore)
        ),
        system=system if system is not None else _stand_in(SystemProbe),
        scan=scan if scan is not None else _fake_walk,
    )


def test_a_constant_stays_a_constant():
    _bind()

    assert gateways.settings.encryption_error == "no se pudo descifrar"
    assert isinstance(gateways.settings.encryption_error, str), (
        "a constant wrapped into a callable is how React error #31 tore the "
        "dashboard down behind ErrorBoundary"
    )


def test_a_function_stays_callable():
    _bind()

    assert gateways.auth_required() is True


def test_an_unknown_name_fails_honestly():
    _bind()

    try:
        gateways.definitely_not_here
    except AttributeError as exc:
        assert "definitely_not_here" in str(exc)
    else:  # pragma: no cover - the bug this guards against
        raise AssertionError("an unknown name resolved to something")


def test_a_binding_missing_a_port_member_fails_immediately():
    """A mis-binding must fail where it is wired, not on the first request.

    `bind` validates each adapter against its port in `application.ports`, so
    `app.py` raising at import replaces a route exploding at runtime with an
    error that names the slot and the missing members.
    """
    with pytest.raises(TypeError, match="arr"):
        gateways.bind(
            arr=ModuleType("arr"),
            settings=_Settings(),
            sqlite_history=ModuleType("hist"),
            credentials_module=ModuleType("creds"),
            system=_stand_in(SystemProbe),
            scan=_fake_walk,
        )


def test_a_scan_that_is_not_callable_fails_at_bind():
    """A one-function port is validated as a callable — here, not on the walk."""
    with pytest.raises(TypeError, match="scan"):
        _bind(scan="not-a-function")


def test_the_real_adapters_satisfy_their_ports():
    """The ports must describe the adapters `app.py` actually binds.

    A member listed on a port but absent from the real module would make the
    composition root fail at startup — the gate works, but only if these four
    are truthful.
    """
    from infrastructure import arr_client
    from infrastructure import credentials as credentials_module
    from infrastructure import settings_store
    from infrastructure import sqlite_history
    from infrastructure import system_probe
    from infrastructure import wanted_scan

    gateways.bind(
        arr=arr_client,
        settings=settings_store,
        sqlite_history=sqlite_history,
        credentials_module=credentials_module,
        system=system_probe,
        scan=wanted_scan.walk,
    )
