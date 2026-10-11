"""Releasing a grab to the arr: an honest failure when it never answers.

`arr_grab_release` is the routed-grab path (destination inside an arr root):
the POST goes to Radarr/Sonarr's `/release`, and when the arr accepts the
request but the reply never arrives, the detail built from the exception is
the only thing the user sees. `str(TimeoutError())` is empty, so the bare
f"{type}: {exc}" pattern produced a user-facing `TimeoutError: ` with an
empty tail — these tests pin the self-describing replacement.
"""

import asyncio

import config
from infrastructure.arr_client import arr_grab_release
from tests._stubs import _StubSession

SERVICE = {"key": "radarr", "api_key": "test-radarr-key", "url": "http://localhost:7878"}

GUID_OK = "cb5e7b266fc735a77132e8cd4f7fbc19"


def test_a_timed_out_grab_says_how_long_it_waited():
    session = _StubSession({"/api/v3/release": (0, asyncio.TimeoutError())})

    result = asyncio.run(arr_grab_release(session, SERVICE, GUID_OK))

    assert result["ok"] is False
    assert "sin respuesta tras" in result["detail"]
    assert f"{int(config.REQUEST_TIMEOUT * 2)}s" in result["detail"]


def test_a_grab_error_with_a_message_keeps_that_message():
    session = _StubSession({"/api/v3/release": (0, asyncio.TimeoutError("went away"))})

    result = asyncio.run(arr_grab_release(session, SERVICE, GUID_OK))

    assert result["detail"] == "TimeoutError: went away"
