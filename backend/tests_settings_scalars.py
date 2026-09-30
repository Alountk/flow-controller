"""The scalars the UI promises are restart-free, read at call time.

`from config import SAFE_MODE` binds the *value*, so no amount of rebuilding
`config` reaches it: a saved `security.safe_mode` was written to disk and
discarded, and the UI reported "Configuración guardada" for it.

`config.rebuild()` refreshes the name in `config`; the readers below are the
ones that had to start asking for `config.X` instead of holding a snapshot.
"""

import copy

import pytest

import config
import settings as settings_mod


@pytest.fixture(autouse=True)
def _restored_settings():
    """Put the settings and the derived constants back after every test."""
    before = copy.deepcopy(settings_mod.get_settings())
    yield
    settings_mod._settings = before
    config.rebuild()


def _set(**path_values) -> None:
    """Write a nested value like `security.safe_mode` straight into memory."""
    for dotted, value in path_values.items():
        keys = dotted.split(".")
        node = settings_mod._settings
        for key in keys[:-1]:
            node = node.setdefault(key, {})
        node[keys[-1]] = value
    config.rebuild()


class TestScalarsAreReadAtCallTime:
    def test_safe_mode_is_applied_without_a_restart(self):
        from app import app
        from fastapi.testclient import TestClient

        client = TestClient(app, raise_server_exceptions=False)
        _set(**{"security.safe_mode": False})

        assert config.SAFE_MODE is False
        body = client.get("/api/actions").json()
        assert body["safe_mode"] is False, (
            "the route still reads the value it bound at import"
        )

    def test_the_tracing_limit_is_applied_without_a_restart(self):
        _set(**{"tracing.limit": 7})
        assert config.TRACE_LIMIT == 7

    def test_a_downloaded_folder_is_applied_without_a_restart(self):
        _set(**{"paths.download_amule": "/somewhere/else"})
        assert config.FOLDER_DOWNLOAD_AMULE == "/somewhere/else"


class TestTheTimeoutIsReadAtCallTime:
    def test_a_saved_timeout_reaches_the_client(self):
        """`intervals.request_timeout` was the last one still bound at import."""
        _set(**{"intervals.request_timeout": 12.5})
        assert config.REQUEST_TIMEOUT == 12.5

    def test_it_is_no_longer_asked_for_a_restart(self):
        from routes.settings import RESTART_REQUIRED_FIELDS

        assert "intervals.request_timeout" not in RESTART_REQUIRED_FIELDS, (
            "the timeout applies immediately now; asking for a restart would be a lie"
        )
