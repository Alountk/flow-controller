"""Tests for the unified TaskManager.

Includes a regression test for a real bug vulture surfaced: `_lock` was created
but never used, so `cleanup()` iterating the registry while another thread
inserted a task could raise
``RuntimeError: dictionary changed size during iteration``.
Task methods are called from both the event loop and worker threads
(``asyncio.to_thread``), so the guard must be a ``threading`` lock.
"""

import threading

from task_manager import TaskManager


def _manager() -> TaskManager:
    return TaskManager(ttl=600)


def test_create_and_get_roundtrip():
    tasks = _manager()
    tasks.create("t1", status="running", detail="hola")

    task = tasks.get("t1")

    assert task is not None
    assert task["id"] == "t1"
    assert task["status"] == "running"
    assert task["detail"] == "hola"
    assert task["cancelled"] is False


def test_get_unknown_task_returns_none():
    assert _manager().get("nope") is None


def test_update_only_touches_existing_tasks():
    tasks = _manager()
    tasks.create("t1", status="running")

    tasks.update("t1", progress=50)
    tasks.update("missing", progress=99)

    assert tasks.get("t1")["progress"] == 50
    assert tasks.get("missing") is None


def test_cancel_sets_flag_and_reports_state():
    tasks = _manager()
    tasks.create("t1", status="running")

    assert tasks.cancel("t1")["ok"] is True
    assert tasks.is_cancelled("t1") is True

    # Cancelling a finished task is refused.
    tasks.update("t1", status="done")
    assert tasks.cancel("t1")["ok"] is False


def test_cancel_unknown_task_fails():
    assert _manager().cancel("nope")["ok"] is False


def test_cleanup_removes_only_expired_finished_tasks():
    tasks = TaskManager(ttl=0)
    tasks.create("done", status="done")
    tasks.create("running", status="running")

    removed = tasks.cleanup()

    assert removed == 1
    assert tasks.get("done") is None
    assert tasks.get("running") is not None


def test_all_tasks_returns_a_snapshot_not_the_live_dict():
    tasks = _manager()
    tasks.create("t1", status="running")

    snapshot = tasks.all_tasks()
    snapshot["t1"]["status"] = "tampered"
    snapshot["injected"] = {"id": "injected"}

    assert tasks.get("t1")["status"] == "running"
    assert tasks.get("injected") is None


class _RecordingLock:
    """Wraps a real lock and counts acquisitions, to prove it is actually used."""

    def __init__(self) -> None:
        self._real = threading.RLock()
        self.acquisitions = 0

    def __enter__(self) -> "_RecordingLock":
        self.acquisitions += 1
        self._real.acquire()
        return self

    def __exit__(self, *exc: object) -> bool:
        self._real.release()
        return False


def test_every_public_method_acquires_the_lock():
    """Regression for the bug vulture surfaced: ``_lock`` was never used.

    A timing-based stress test is unreliable here — the failure window is tiny
    and the CI machine may never hit it. Asserting that each method actually
    takes the lock is deterministic and catches exactly the defect: the guard
    being constructed and then ignored.
    """
    tasks = TaskManager(ttl=0)
    lock = _RecordingLock()
    tasks._lock = lock  # type: ignore[assignment]

    tasks.create("t1", status="running")
    tasks.get("t1")
    tasks.update("t1", progress=10)
    tasks.is_cancelled("t1")
    tasks.cancel("t1")
    tasks.update("t1", status="done")
    tasks.cleanup()
    tasks.all_tasks()

    assert lock.acquisitions >= 8, (
        "TaskManager methods ran without taking the lock; the registry is not "
        "protected against concurrent access from worker threads."
    )


def test_lock_is_threading_not_asyncio():
    """The guard must be a threading lock: callers run in `asyncio.to_thread`."""
    lock = TaskManager()._lock

    assert isinstance(lock, type(threading.RLock())), (
        f"TaskManager._lock is {type(lock).__name__}; it must be a threading lock "
        "because update()/is_cancelled() are called from worker threads."
    )


def test_concurrent_access_is_safe_smoke():
    """Smoke test: threads creating and cleaning up must not raise."""
    tasks = TaskManager(ttl=0)
    errors: list[BaseException] = []

    def churn(prefix: str) -> None:
        try:
            for i in range(200):
                tasks.create(f"{prefix}-{i}", status="done")
                tasks.cleanup()
                tasks.get(f"{prefix}-{i}")
        except BaseException as exc:  # noqa: BLE001 - recorded and asserted below
            errors.append(exc)

    threads = [threading.Thread(target=churn, args=(name,)) for name in ("a", "b", "c")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == [], f"concurrent access raised: {errors!r}"
