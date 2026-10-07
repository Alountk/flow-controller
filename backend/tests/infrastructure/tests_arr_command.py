"""``arr_command`` keeps the handle Radarr gives back — and can cancel it.

The 2026-10-07 incident: one ``POST /api/wanted/search`` fired a mass
``MissingMoviesSearch`` (24 grabs) and nothing could stop it — the command id
Radarr returns in the response body was never read, so
``DELETE /api/v3/command/{id}`` had no id to address.

Contract pinned here:

- a successful command returns its ``command_id`` (the body's ``id``), when
  the body carries one;
- a body without an id still succeeds (``command_id`` simply absent) — a 200
  with less is not our failure;
- a failed command carries no id;
- cancelling goes to ``DELETE /api/v3/command/{id}`` and reports the arr's own
  answer;
- a 404 reads as "already gone", honestly — never as success.
"""

import asyncio

from infrastructure.arr_client import arr_cancel_command, arr_command
from tests._stubs import _StubSession

RADARR_URL = "http://radarr.test:7878"
SERVICE = {"key": "radarr", "kind": "arr", "url": RADARR_URL, "api_key": "test-key"}


def _session(status: int, payload: dict, url: str = f"{RADARR_URL}/api/v3/command") -> _StubSession:
    return _StubSession({url: (status, payload)})


def test_a_successful_command_carries_its_command_id():
    result = asyncio.run(
        arr_command(_session(200, {"id": 42, "status": "started"}), SERVICE, {"name": "MissingMoviesSearch"})
    )

    assert result["ok"] is True
    assert result["command_id"] == 42


def test_a_body_without_an_id_still_succeeds():
    result = asyncio.run(
        arr_command(_session(200, {"name": "RefreshMovie"}), SERVICE, {"name": "RefreshMovie"})
    )

    assert result["ok"] is True
    assert "command_id" not in result


def test_a_failed_command_carries_no_id():
    result = asyncio.run(
        arr_command(_session(400, {"errorMessage": "nope"}), SERVICE, {"name": "Nope"})
    )

    assert result["ok"] is False
    assert "command_id" not in result


def test_cancel_deletes_the_command_by_id():
    session = _session(200, {}, url=f"{RADARR_URL}/api/v3/command/42")

    result = asyncio.run(arr_cancel_command(session, SERVICE, 42))

    assert result == {"ok": True, "detail": "Comando 42 cancelado"}
    assert session.calls[0][0] == f"{RADARR_URL}/api/v3/command/42"


def test_cancel_reports_an_already_finished_command_as_gone():
    """404 means the command no longer exists — say so; do not claim success."""
    session = _session(404, {}, url=f"{RADARR_URL}/api/v3/command/42")

    result = asyncio.run(arr_cancel_command(session, SERVICE, 42))

    assert result["ok"] is False
    assert "no encontrado" in result["detail"]


def test_cancel_surfaces_an_unexpected_status_verbatim():
    session = _session(500, {}, url=f"{RADARR_URL}/api/v3/command/42")

    result = asyncio.run(arr_cancel_command(session, SERVICE, 42))

    assert result["ok"] is False
    assert "HTTP 500" in result["detail"]
