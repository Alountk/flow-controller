"""`application.gateways` hands delivery what it is, not what it can call.

The generated delegates were right for functions and wrong for everything else:
`settings_store.encryption_error` is a module-level STRING, and wrapping it in a
callable made the route return the callable. `jsonable_encoder` rendered that as
`{}`, React error #31 — objects are not valid as a React child — tore the
dashboard down behind ErrorBoundary, and every single request stayed green.
Two end-to-end specs failed at a 5 s DOM timeout over it.
"""

from __future__ import annotations

from types import ModuleType

import pytest

from application import gateways


@pytest.fixture(autouse=True)
def _restore_the_real_adapters():
    """`bind` is module state. A fake left behind poisons every later test."""
    saved = (gateways._arr, gateways._settings, gateways.history, gateways.credentials)
    yield
    gateways._arr, gateways._settings, gateways.history, gateways.credentials = saved


class _Settings:
    """A stand-in adapter: one constant, one function."""

    encryption_error = "no se pudo descifrar"
    auth_required = staticmethod(lambda: True)


def test_a_constant_stays_a_constant(tmp_path):
    gateways.bind(
        arr=ModuleType("arr"),
        settings=_Settings(),
        sqlite_history=ModuleType("hist"),
        credentials_module=ModuleType("creds"),
    )
    assert gateways.encryption_error == "no se pudo descifrar"
    assert isinstance(gateways.encryption_error, str)


def test_a_function_stays_callable(tmp_path):
    gateways.bind(
        arr=ModuleType("arr"),
        settings=_Settings(),
        sqlite_history=ModuleType("hist"),
        credentials_module=ModuleType("creds"),
    )
    assert gateways.auth_required() is True


def test_an_unknown_name_fails_honestly():
    gateways.bind(
        arr=ModuleType("arr"),
        settings=_Settings(),
        sqlite_history=ModuleType("hist"),
        credentials_module=ModuleType("creds"),
    )
    try:
        gateways.definitely_not_here
    except AttributeError as exc:
        assert "definitely_not_here" in str(exc)
    else:  # pragma: no cover - the bug this guards against
        raise AssertionError("an unknown name resolved to something")
