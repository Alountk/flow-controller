"""Tests for the auto-copy sweep driver.

The pure policy is covered in tests_auto_copy.py; these tests own the I/O the
driver adds: which traces are acted on, how a second concurrent sweep is
refused, when the arr is probed, and what the durable marker records. The
traces, the registry, the arr probe, the marker store and the copy engine are
all stubbed, so nothing here touches the network or a real database — except
the two integration tests that use a real in-memory history to prove the
proposal/action distinction end to end.
"""

import asyncio
from datetime import datetime, timezone

import pytest

import auto_copy_driver as driver
import history
from auto_copy import COPY, SKIP, WAIT, auto_copy_key

GRAB_AT = 10_000.0


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _trace(
    *,
    source="radarr",
    download_id="a" * 40 + "00000000",
    movie_id=855,
    episode_id=None,
    stage="import_blocked",
    queue_status="warning",
    date=None,
    content_path="/mnt/storage/downloads/qbittorrent/completed/Your.Name",
):
    return {
        "source": source,
        "title": "Your Name.",
        "download_id": download_id,
        "date": _iso(GRAB_AT + 3) if date is None else date,
        "stage": stage,
        "ids": {
            "movie_id": movie_id,
            "episode_id": episode_id,
            "series_id": None,
            "queue_id": 1,
        },
        "torrent": {"content_path": content_path} if content_path else None,
        "queue": {"state": "importPending", "status": queue_status},
    }


def _own_grab(movie_id=855, *, source="radarr", grabbed_at=GRAB_AT):
    return {
        "id": 1,
        "source": source,
        "movie_id": movie_id,
        "episode_id": None,
        "series_id": None,
        "guid": "g",
        "indexer_id": 1,
        "grabbed_at": grabbed_at,
    }


class _Calls:
    """Records every stubbed call so a test can assert on it."""

    def __init__(self):
        self.has_file = 0
        self.handled: list[str] = []
        self.mark: list[dict] = []
        self.dispatch: list[dict] = []
        self.order: list[tuple[str, str]] = []


def _install(
    monkeypatch,
    *,
    traces,
    own_grabs,
    handled=False,
    has_file=None,
    dispatch_ok=True,
    dispatch_exc=None,
    build_exc=None,
    real_marker=False,
) -> _Calls:
    """Stub every I/O boundary the driver crosses."""
    calls = _Calls()

    async def build_traces(session):
        # Yield so a concurrently scheduled second sweep sees the lock held.
        await asyncio.sleep(0)
        if build_exc is not None:
            raise build_exc
        return list(traces)

    async def arr_probe(session, service, *, movie_id=None, episode_id=None):
        calls.has_file += 1
        return has_file

    async def do_action(session, action, payload):
        calls.dispatch.append({"action": action, "payload": payload})
        calls.order.append(("dispatch", action))
        if dispatch_exc is not None:
            raise dispatch_exc
        if dispatch_ok:
            return {"ok": True, "task_id": "t1", "dst_path": "/lib/Your.Name (2016)"}
        return {
            "ok": False,
            "steps": [{"target": "arr", "ok": False, "detail": "no se pudo obtener la carpeta raíz"}],
        }

    monkeypatch.setattr(driver, "build_traces", build_traces)
    monkeypatch.setattr(driver, "list_own_grabs", lambda *a, **k: list(own_grabs))
    monkeypatch.setattr(driver, "arr_has_file", arr_probe)
    monkeypatch.setattr(driver, "do_action", do_action)

    if not real_marker:
        def is_handled(key):
            calls.handled.append(key)
            if callable(handled):
                return handled(key)
            return bool(handled)

        def mark(key, *, source, title=None, decision, reason=None):
            calls.mark.append(
                {
                    "key": key,
                    "source": source,
                    "title": title,
                    "decision": decision,
                    "reason": reason,
                }
            )
            calls.order.append(("mark", decision))

        monkeypatch.setattr(driver, "is_auto_copy_handled", is_handled)
        monkeypatch.setattr(driver, "mark_auto_copy", mark)

    return calls


def _sweep(**kwargs):
    return asyncio.run(driver.sweep(None, **kwargs))


# ── Whose grab is it ─────────────────────────────────────────────────────────


def test_a_grab_that_is_not_provably_ours_is_skipped(monkeypatch):
    calls = _install(monkeypatch, traces=[_trace()], own_grabs=[])

    summary = _sweep(safe_mode=False)

    assert summary["entries"][0]["decision"] == SKIP
    assert "grab lanzado desde la app" in summary["entries"][0]["reason"]
    assert calls.dispatch == []
    assert calls.mark == []


def test_our_own_grab_is_proposed_and_counted(monkeypatch):
    calls = _install(monkeypatch, traces=[_trace()], own_grabs=[_own_grab()])

    summary = _sweep(safe_mode=True)

    assert summary["entries"][0]["decision"] == COPY
    assert summary["counts"]["copy"] == 1
    assert summary["counts"]["proposed"] == 1
    assert calls.mark[0]["decision"] == driver.PROPOSED_DECISION


def test_an_already_actioned_marker_is_skipped(monkeypatch):
    calls = _install(
        monkeypatch, traces=[_trace()], own_grabs=[_own_grab()], handled=True
    )

    summary = _sweep(safe_mode=False)

    assert summary["entries"][0]["decision"] == SKIP
    assert summary["entries"][0]["reason"] == "ya se copió antes"
    assert calls.dispatch == []
    assert calls.mark == []


# ── Safe mode ────────────────────────────────────────────────────────────────


def test_safe_mode_proposes_and_dispatches_nothing(monkeypatch):
    calls = _install(monkeypatch, traces=[_trace()], own_grabs=[_own_grab()])

    summary = _sweep(safe_mode=True)

    entry = summary["entries"][0]
    assert entry["decision"] == COPY
    assert entry["action"] == "proposed"
    assert calls.dispatch == [], "safe mode must touch nothing"
    assert [m["decision"] for m in calls.mark] == [driver.PROPOSED_DECISION]
    assert summary["counts"]["copied"] == 0


def test_safe_mode_off_dispatches_and_marks(monkeypatch):
    calls = _install(monkeypatch, traces=[_trace()], own_grabs=[_own_grab()])

    summary = _sweep(safe_mode=False)

    entry = summary["entries"][0]
    assert entry["action"] == "copied"
    assert calls.dispatch[0]["action"] == "copy_files"
    assert calls.dispatch[0]["payload"] == {
        "source": "radarr",
        "ids": {"movie_id": 855, "episode_id": None, "series_id": None, "queue_id": 1},
        "output_path": "/mnt/storage/downloads/qbittorrent/completed/Your.Name",
    }
    assert [m["decision"] for m in calls.mark] == [history.DECISION_ACTIONED]
    assert summary["counts"]["copied"] == 1


def test_the_marker_is_persisted_before_dispatching(monkeypatch):
    """Claim before acting: a crash mid-copy must not let the next sweep
    dispatch a duplicate."""
    calls = _install(monkeypatch, traces=[_trace()], own_grabs=[_own_grab()])

    _sweep(safe_mode=False)

    assert calls.order == [
        ("mark", history.DECISION_ACTIONED),
        ("dispatch", "copy_files"),
    ]


def test_a_failed_dispatch_leaves_a_retry_possible(monkeypatch):
    calls = _install(
        monkeypatch, traces=[_trace()], own_grabs=[_own_grab()], dispatch_ok=False
    )

    summary = _sweep(safe_mode=False)

    assert summary["entries"][0]["action"] == "failed"
    # The claim is downgraded to the non-actioned label; only
    # `history.is_auto_copy_handled` counting actioned decisions makes the retry
    # actually possible (see tests_history.py).
    assert [m["decision"] for m in calls.mark] == [
        history.DECISION_ACTIONED,
        driver.FAILED_DECISION,
    ]
    assert summary["counts"]["failed"] == 1


def test_a_dispatch_that_raises_also_leaves_a_retry_possible(monkeypatch):
    calls = _install(
        monkeypatch,
        traces=[_trace()],
        own_grabs=[_own_grab()],
        dispatch_exc=RuntimeError("engine blew up"),
    )

    summary = _sweep(safe_mode=False)

    assert summary["entries"][0]["action"] == "failed"
    assert [m["decision"] for m in calls.mark] == [
        history.DECISION_ACTIONED,
        driver.FAILED_DECISION,
    ]


def test_a_trace_without_content_path_fails_without_dispatching(monkeypatch):
    calls = _install(
        monkeypatch,
        traces=[_trace(content_path=None)],
        own_grabs=[_own_grab()],
    )

    summary = _sweep(safe_mode=False)

    assert summary["entries"][0]["action"] == "failed"
    assert calls.dispatch == []
    assert calls.mark[0]["decision"] == driver.FAILED_DECISION


# ── The shared sentinel ──────────────────────────────────────────────────────


def test_the_unidentified_key_never_gets_a_marker(monkeypatch):
    trace = _trace(download_id="", movie_id=None)
    assert auto_copy_key(trace).endswith(":title:unidentified")
    calls = _install(monkeypatch, traces=[trace], own_grabs=[])

    summary = _sweep(safe_mode=False)

    assert summary["entries"][0]["decision"] == SKIP
    assert calls.mark == [], "a shared sentinel must never be persisted"
    assert calls.handled == [], "the sentinel must not even be read"


# ── When the arr is asked ────────────────────────────────────────────────────


def test_has_file_is_queried_only_for_plausibly_actionable_traces(monkeypatch):
    actionable = _trace(download_id="a" * 40, movie_id=855)
    handled_trace = _trace(download_id="b" * 40, movie_id=856)
    not_ours = _trace(download_id="c" * 40, movie_id=999)
    still_downloading = _trace(
        download_id="d" * 40, movie_id=857, stage="downloading", queue_status="ok"
    )
    handled_keys = {auto_copy_key(handled_trace)}
    calls = _install(
        monkeypatch,
        traces=[actionable, handled_trace, not_ours, still_downloading],
        own_grabs=[_own_grab(855), _own_grab(856), _own_grab(857)],
        handled=lambda key: key in handled_keys,
    )

    summary = _sweep(safe_mode=False)

    by_key = {e["key"]: e for e in summary["entries"]}
    assert calls.has_file == 1, "one probe per sweep is one request per trace"
    assert by_key[auto_copy_key(actionable)]["decision"] == COPY
    assert by_key[auto_copy_key(handled_trace)]["decision"] == SKIP
    assert by_key[auto_copy_key(not_ours)]["decision"] == SKIP
    assert by_key[auto_copy_key(still_downloading)]["decision"] == WAIT
    assert summary["counts"]["traces"] == 4
    assert summary["counts"]["wait"] == 1
    assert summary["counts"]["skip"] == 2


# ── Nothing durable for transient or changing conditions ─────────────────────


def test_waiting_and_skipping_write_nothing(monkeypatch):
    waiting = _trace(download_id="a" * 40, stage="downloading", queue_status="ok")
    failing = _trace(download_id="b" * 40, stage="failed")
    calls = _install(
        monkeypatch, traces=[waiting, failing], own_grabs=[_own_grab(855)]
    )

    summary = _sweep(safe_mode=False)

    assert [e["decision"] for e in summary["entries"]] == [WAIT, SKIP]
    assert calls.mark == []
    assert calls.has_file == 0, "no actionable stage means no probe"


# ── Concurrency and degradation ──────────────────────────────────────────────


def test_two_concurrent_sweeps_run_one_dispatch(monkeypatch):
    calls = _install(monkeypatch, traces=[_trace()], own_grabs=[_own_grab()])

    async def both():
        return await asyncio.gather(
            driver.sweep(None, safe_mode=False),
            driver.sweep(None, safe_mode=False),
        )

    first, second = asyncio.run(both())

    running = [r for r in (first, second) if r["running"]]
    assert len(running) == 1, "the second caller must be refused, not queued"
    assert running[0]["detail"] == "ya hay un barrido en curso"
    assert len([r for r in (first, second) if r["ok"]]) == 1
    assert len(calls.dispatch) == 1, "two concurrent sweeps must not both dispatch"


def test_an_empty_trace_list_is_a_clean_sweep(monkeypatch):
    _install(monkeypatch, traces=[], own_grabs=[])

    summary = _sweep(safe_mode=True)

    assert summary["ok"] is True
    assert summary["counts"]["traces"] == 0
    assert summary["entries"] == []


def test_a_trace_source_failure_degrades_instead_of_raising(monkeypatch):
    _install(
        monkeypatch,
        traces=[],
        own_grabs=[],
        build_exc=RuntimeError("traces down"),
    )

    summary = _sweep(safe_mode=False)

    assert summary["ok"] is False
    assert summary["running"] is False
    assert "traces down" in summary["errors"][0]


def test_one_failing_trace_does_not_abort_the_sweep(monkeypatch):
    """A malformed trace is skipped and reported, not fatal to the rest."""
    good = _trace(download_id="a" * 40, movie_id=855)
    bad = _trace(download_id="b" * 40, movie_id=856)
    calls = _install(monkeypatch, traces=[bad, good], own_grabs=[_own_grab(855)])
    original = driver._handle_trace

    async def explode_first(session, trace, **kwargs):
        if trace is bad:
            raise ValueError("malformed trace")
        return await original(session, trace, **kwargs)

    monkeypatch.setattr(driver, "_handle_trace", explode_first)

    summary = _sweep(safe_mode=False)

    assert summary["ok"] is True
    assert summary["counts"]["traces"] == 2
    assert len(summary["entries"]) == 1
    assert summary["errors"], "the skipped trace must be reported"
    assert len(calls.dispatch) == 1


# ── End to end with a real marker store ──────────────────────────────────────


@pytest.fixture
def db(tmp_path):
    history.close()
    history.init_db(tmp_path / "history.db")
    yield
    history.close()


def test_a_proposal_does_not_block_a_later_acting_sweep(monkeypatch, db):
    """The bug the semantics fix closes: propose under safe mode, then act with
    it off. Before, the proposal read as handled and the copy never happened."""
    calls = _install(
        monkeypatch,
        traces=[_trace()],
        own_grabs=[_own_grab()],
        real_marker=True,
    )

    first = _sweep(safe_mode=True)
    assert first["entries"][0]["action"] == "proposed"
    assert calls.dispatch == []

    second = _sweep(safe_mode=False)
    assert second["entries"][0]["action"] == "copied"
    assert len(calls.dispatch) == 1


def test_an_actioned_marker_does_block_a_later_sweep(monkeypatch, db):
    calls = _install(
        monkeypatch,
        traces=[_trace()],
        own_grabs=[_own_grab()],
        real_marker=True,
    )

    first = _sweep(safe_mode=False)
    assert first["entries"][0]["action"] == "copied"

    second = _sweep(safe_mode=False)
    assert second["entries"][0]["decision"] == SKIP
    assert len(calls.dispatch) == 1, "the acted marker must block the repeat"


def test_a_failed_dispatch_is_retried_on_the_next_sweep(monkeypatch, db):
    calls = _install(
        monkeypatch,
        traces=[_trace()],
        own_grabs=[_own_grab()],
        dispatch_ok=False,
        real_marker=True,
    )

    first = _sweep(safe_mode=False)
    assert first["entries"][0]["action"] == "failed"

    second = _sweep(safe_mode=False)
    assert second["entries"][0]["action"] == "failed"
    assert len(calls.dispatch) == 2, "a failed dispatch must stay retryable"
