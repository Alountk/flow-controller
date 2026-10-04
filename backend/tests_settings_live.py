"""Saving a setting must apply it, or say that it cannot.

`config.py` computed every settings-backed constant once, at import. Modules
then did `from config import SAFE_MODE`, which binds the *value*, so nothing
downstream could ever see an update. Two consequences, both user-facing:

- the file manager ignored `paths.allowed_roots` entirely — three modules
  carried their own hardcoded `["/mnt/storage", "/mnt/storage-6tb"]`, so a
  root the user configured was honoured by the destination combo and ignored
  by the browser;
- the UI reported "Configuración guardada" for fields it had silently
  discarded, because they were absent from `RESTART_REQUIRED_FIELDS`.

`config.rebuild()` closes both: containers are mutated in place (so the
`from config import SERVICES` holders see the new contents with no call-site
change) and every scalar the UI promises is restart-free is read from
`config.X` at call time.
"""

import copy

import pytest

import config
from infrastructure import settings_store as settings_mod


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


class TestContainersAreMutatedInPlace:
    """`from config import SERVICES` binds the list, not its contents."""

    def test_a_saved_service_is_visible_without_a_restart(self):
        _set(**{"services.radarr.url": "http://new-host:7878"})

        service = config.find_service("radarr", "arr")
        assert service is not None
        assert service["url"] == "http://new-host:7878", (
            "SERVICES was rebuilt into a NEW list, so every module holding the old one "
            "would keep the stale URL until a restart"
        )

    def test_the_allowed_roots_reach_the_file_manager(self):
        """The three hardcoded copies ignored `paths.allowed_roots`."""
        import os

        _set(**{"paths.allowed_roots": ["/mnt/somewhere-else"]})

        from interfaces.http.routes.files import _validate_path
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            _validate_path("/mnt/storage/movies/x.mkv")
        assert exc.value.status_code == 403, (
            "the file manager still trusts its own hardcoded roots instead of settings"
        )
        # And the configured root is the one that is accepted.
        assert os.path.isabs(_validate_path("/mnt/somewhere-else/x.mkv"))


class TestTheRestartListTellsTheTruth:
    def test_a_field_that_applies_immediately_is_not_asked_for_a_restart(self):
        from interfaces.http.routes.settings import RESTART_REQUIRED_FIELDS

        # Services are rebuilt in place and `security.api_key` is read live by
        # `settings.auth_required`; neither needs a restart any more.
        assert not any(f.startswith("services.") for f in RESTART_REQUIRED_FIELDS), (
            "the UI still asks for a restart on fields that already applied"
        )
        assert "security.api_key" not in RESTART_REQUIRED_FIELDS, (
            "auth_required() reads the settings on every request, by its own docstring"
        )
        assert RESTART_REQUIRED_FIELDS, "the port still needs one"
