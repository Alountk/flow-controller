"""C-05: the HTTP edge — an id on every answer, budgets on every client.

The four properties the parent task pins, tested at the only seam that can
prove them (the ASGI app through `TestClient`), plus the two facts that make
the design honest: the store behind the budget is bounded, and a client that
presents the real key gets its own bucket rather than the address-only one.

Budgets are hit against their REAL defaults (300 requests, 10 failed key
attempts) so the defaults themselves are under test — no test-only limits
are injected, and `tests/conftest.py` resets the counters around each test.
"""

import re
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import app

client = TestClient(app, raise_server_exceptions=False)

_CHECK = "/api/auth/check"

#: uuid4 hex, as the edge generates when no inbound id arrives.
_GENERATED = re.compile(r"\A[0-9a-f]{32}\Z")
#: What an inbound id must look like to be echoed instead of replaced.
_ECHOABLE = re.compile(r"\A[A-Za-z0-9._-]{1,64}\Z")


# ── Request id ───────────────────────────────────────────────────────────────


def test_every_response_carries_a_generated_request_id():
    for path in (_CHECK, "/"):  # a route and the static/SPA surface alike
        resp = client.get(path)

        rid = resp.headers.get("X-Request-Id")
        assert rid is not None, f"every response carries X-Request-Id ({path})"
        assert _GENERATED.match(rid), f"generated id is uuid4 hex, got {rid!r}"


def test_a_well_formed_inbound_request_id_is_echoed_verbatim():
    resp = client.get(_CHECK, headers={"X-Request-Id": "trace-abc.123_XYZ"})

    assert resp.headers.get("X-Request-Id") == "trace-abc.123_XYZ"


def test_an_overlong_inbound_request_id_is_replaced_not_echoed():
    inbound = "a" * 65  # one past the bound — too long to travel back out

    resp = client.get(_CHECK, headers={"X-Request-Id": inbound})

    rid = resp.headers.get("X-Request-Id")
    assert rid is not None
    assert rid != inbound, "an overlong id must never be echoed back"
    assert _ECHOABLE.match(rid)


def test_an_inbound_request_id_outside_the_charset_is_replaced():
    inbound = "not a valid id!"  # spaces and punctuation: header-injection bait

    resp = client.get(_CHECK, headers={"X-Request-Id": inbound})

    rid = resp.headers.get("X-Request-Id")
    assert rid is not None
    assert rid != inbound, "an out-of-charset id must never be echoed back"
    assert _ECHOABLE.match(rid)


# ── Rate limiting ────────────────────────────────────────────────────────────


def test_the_general_budget_answers_429_with_a_retryable_body():
    """One over the default (300/60s) is refused, machine-readably."""
    warm = client.get(_CHECK)
    assert warm.status_code == 200, "under the budget the app answers normally"

    for _ in range(299):  # warm-up + these = exactly the 300 allowed
        assert client.get(_CHECK).status_code != 429, (
            "the budget must hold until its documented limit"
        )

    resp = client.get(_CHECK)

    assert resp.status_code == 429
    body = resp.json()
    assert body["detail"] == "Límite de peticiones superado"
    assert isinstance(body["retry_after"], int) and body["retry_after"] >= 1
    assert resp.headers.get("Retry-After") == str(body["retry_after"])
    assert resp.headers.get("X-Request-Id") is not None, (
        "the refusal carries the id like any other answer"
    )


def test_repeated_api_key_failures_lock_the_client_out():
    """The auth path is the one that matters: 10 rejections, then 429."""
    with patch("infrastructure.settings_store.auth_required", return_value=True), patch(
        "interfaces.http.deps.credentials"
    ) as creds:
        creds.verify_api_key.return_value = False

        for _ in range(10):
            assert client.get(_CHECK).status_code == 401, (
                "the first attempts are answered honestly"
            )

        resp = client.get(_CHECK)

    assert resp.status_code == 429, "the eleventh attempt never reaches the key check"
    body = resp.json()
    assert body["detail"] == "Demasiados intentos de API key"
    assert isinstance(body["retry_after"], int) and body["retry_after"] >= 1
    assert resp.headers.get("Retry-After") == str(body["retry_after"])


def test_an_authenticated_client_gets_its_own_budget():
    """A key that verifies keys separately from the bare address.

    Exhaust the GOOD-key bucket (300 + 1) and a keyless request still gets
    its own address bucket — it is answered 401 by the key check, not 429 by
    the budget the GOOD key ran out of.
    """
    with patch("infrastructure.settings_store.auth_required", return_value=True), patch(
        "interfaces.http.deps.credentials"
    ) as creds:
        creds.verify_api_key.side_effect = (
            lambda candidate, salt, expected: candidate == "GOODKEY"
        )

        for _ in range(300):
            assert (
                client.get(_CHECK, headers={"X-Api-Key": "GOODKEY"}).status_code == 200
            ), "under budget the authenticated client passes"

        exhausted = client.get(_CHECK, headers={"X-Api-Key": "GOODKEY"})
        keyless = client.get(_CHECK)

    assert exhausted.status_code == 429, "the key's own bucket ran out"
    assert keyless.status_code == 401, (
        "a keyless request falls to the address bucket: rejected by the key "
        "check, not refused by the exhausted authenticated bucket"
    )


def test_the_request_id_reaches_the_log_when_a_request_fails(caplog):
    """The id is not decoration: a failing answer is answerable in the log."""
    with patch("infrastructure.settings_store.auth_required", return_value=True), patch(
        "interfaces.http.deps.credentials"
    ) as creds:
        creds.verify_api_key.return_value = False
        resp = client.get(_CHECK)

    rid = resp.headers.get("X-Request-Id")
    assert rid is not None, "the failing response carries its id"
    assert f"request_id={rid}" in caplog.text, (
        "a failed request logs with the id the response carries"
    )


def test_an_unhandled_crash_is_logged_with_its_id(caplog):
    """Even the answer this layer never gets to stamp is traceable in the log.

    The framework's plain-text 500 is generated above the edge middleware,
    so the header is not there — the id is, and that is the contract.
    """
    with patch(
        "infrastructure.settings_store.auth_required",
        side_effect=RuntimeError("boom"),
    ):
        resp = client.get(_CHECK, headers={"X-Api-Key": "whatever"})

    assert resp.status_code == 500
    assert re.search(r"request_id=[0-9a-f]{32}", caplog.text), (
        "the crash is logged with a generated id"
    )


# ── The store behind the budget ──────────────────────────────────────────────


def test_the_window_rolls_over_and_the_budget_returns():
    """Rollover without sleeping: the clock is part of the limiter's interface."""
    from interfaces.http.rate_limit import FixedWindow

    now = [1000.0]
    window = FixedWindow(limit=2, window=60, clock=lambda: now[0])

    assert window.hit("k") == (True, 0)
    assert window.hit("k") == (True, 0)
    assert window.hit("k")[0] is False, "the third arrival is over budget"

    now[0] += 60  # the window expires — the count starts over
    assert window.hit("k") == (True, 0)
    assert window.peek("k") is None


def test_the_store_stops_growing_at_its_bound():
    """Keys are attacker-influenced; the dict must not be a memory amplifier."""
    from interfaces.http.rate_limit import MAX_KEYS, FixedWindow

    window = FixedWindow(limit=1, window=60)
    for i in range(MAX_KEYS + 100):
        window.hit(f"key-{i}")

    assert len(window._counts) <= MAX_KEYS, (
        "a flood of distinct keys must not grow the store past its bound"
    )
