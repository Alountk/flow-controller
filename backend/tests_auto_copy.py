"""Tests for the pure copy decision (T3).

No network and no fixtures: the policy is a plain function over a trace dict,
so every rule is pinned by constructing the exact trace that reaches it.
"""

from pathlib import Path

from auto_copy import COPY, DEFAULT_GRACE_SECONDS, SKIP, WAIT, decide_copy

MODULE_PATH = Path(__file__).resolve().parent / "auto_copy.py"


def _trace(stage=None, queue=None):
    trace = {}
    if stage is not None:
        trace["stage"] = stage
    if queue is not None:
        trace["queue"] = queue
    return trace


def test_skips_a_grab_the_app_did_not_launch():
    result = decide_copy(_trace("downloaded"), now=10_000, since=0, is_own_grab=False)
    assert result["decision"] == SKIP
    assert "grab lanzado desde la app" in result["reason"]


def test_skips_when_already_copied():
    result = decide_copy(_trace("downloaded"), now=10_000, since=0, already_handled=True)
    assert result["decision"] == SKIP
    assert result["reason"] == "ya se copió antes"


def test_skips_when_the_arr_already_has_the_file():
    result = decide_copy(_trace("downloaded"), now=10_000, since=0, arr_has_file=True)
    assert result["decision"] == SKIP
    assert result["reason"] == "el arr ya tiene el fichero"


def test_skips_a_failed_download():
    result = decide_copy(_trace("failed"), now=10_000, since=0)
    assert result["decision"] == SKIP
    assert result["reason"] == "la descarga falló"


def test_waits_while_the_download_is_still_running():
    for stage in ("sent", "downloading"):
        result = decide_copy(_trace(stage), now=10_000, since=0)
        assert result["decision"] == WAIT, stage
        assert "sigue en curso" in result["reason"]


def test_waits_while_the_arr_is_importing():
    result = decide_copy(_trace("importing"), now=10_000, since=0)
    assert result["decision"] == WAIT
    assert "no se compite con él" in result["reason"]


def test_waits_on_a_healthy_import_pending_because_the_arr_is_not_stuck():
    # derive_stage maps importPending to import_blocked, but importPending is
    # ALSO the normal transient state right before a healthy import. The tie
    # breaker is queue["status"]: without a warning there is no proof the arr
    # is stuck, so copying here is exactly the race D2 forbids.
    queue = {"state": "importPending", "status": "ok"}
    result = decide_copy(_trace("import_blocked", queue), now=10_000, since=9_999)
    assert result["decision"] == WAIT
    assert "gracia" in result["reason"]


def test_copies_immediately_on_an_import_warning_without_a_time_reference():
    queue = {"state": "importPending", "status": "warning"}
    result = decide_copy(_trace("import_blocked", queue), now=10_000, since=None)
    assert result["decision"] == COPY
    assert "warning" in result["reason"]


def test_waits_just_inside_the_grace_window():
    result = decide_copy(_trace("downloaded"), now=DEFAULT_GRACE_SECONDS - 1, since=0)
    assert result["decision"] == WAIT
    assert "ventana de gracia" in result["reason"]


def test_copies_just_after_the_grace_window():
    result = decide_copy(_trace("downloaded"), now=DEFAULT_GRACE_SECONDS + 1, since=0)
    assert result["decision"] == COPY
    assert "no lo importó" in result["reason"]


def test_a_future_since_waits_like_within_the_grace():
    result = decide_copy(_trace("downloaded"), now=1_000, since=2_000)
    assert result["decision"] == WAIT


def test_arr_has_file_false_does_not_skip():
    result = decide_copy(
        _trace("downloaded"),
        now=DEFAULT_GRACE_SECONDS + 1,
        since=0,
        arr_has_file=False,
    )
    assert result["decision"] == COPY


def test_arr_has_file_unknown_does_not_skip():
    result = decide_copy(
        _trace("downloaded"),
        now=DEFAULT_GRACE_SECONDS + 1,
        since=0,
        arr_has_file=None,
    )
    assert result["decision"] == COPY


def test_waits_without_a_time_reference():
    result = decide_copy(_trace("downloaded"), now=10_000, since=None)
    assert result["decision"] == WAIT
    assert "sin referencia temporal" in result["reason"]


def test_skips_an_unknown_stage():
    result = decide_copy(_trace("teleporting"), now=10_000, since=0)
    assert result["decision"] == SKIP
    assert "desconocido" in result["reason"]


def test_a_trace_missing_the_stage_fails_closed():
    result = decide_copy({}, now=10_000, since=0)
    assert result["decision"] == SKIP
    assert "desconocido" in result["reason"]


def test_a_trace_missing_the_queue_still_decides():
    result = decide_copy(_trace("import_blocked"), now=10_000, since=None)
    assert result["decision"] == WAIT
    assert "sin referencia temporal" in result["reason"]


def test_does_not_mutate_the_trace():
    trace = _trace("import_blocked", {"state": "importPending", "status": "warning"})
    before = dict(trace)
    decide_copy(trace, now=10_000, since=0)
    assert trace == before


def test_the_policy_module_has_no_side_effect_imports():
    source = MODULE_PATH.read_text()
    forbidden = (
        "aiohttp",
        "from state",
        "from history",
        "from config",
        "import os",
        "import time",
    )
    found = [token for token in forbidden if token in source]
    assert not found, (
        "the pure policy must not grow a session, a clock or configuration; "
        f"found: {found}"
    )
