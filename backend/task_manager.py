"""Unified task management for background operations.

Provides a single TaskManager class used by copy_engine and media_mixer.
The file_queue in routes/files.py uses a different pattern (sequential queue)
and stays separate.

Concurrency: methods are called from the event loop *and* from worker threads
(``asyncio.to_thread`` runs the chunked copy and mux loops off-loop, and those
call ``update``/``is_cancelled``). A ``threading.RLock`` guards the registry;
without it, ``cleanup()`` iterating while another thread inserts a task raises
``RuntimeError: dictionary changed size during iteration``.
"""

import logging
import threading
import time

import event_bus

log = logging.getLogger("flow-controller")


class TaskManager:
    """Thread-safe task registry for background operations."""

    def __init__(self, ttl: float = 600):
        self._tasks: dict[str, dict] = {}
        self._lock = threading.RLock()
        self._ttl = ttl

    def create(self, task_id: str, channel: str = "", **kwargs) -> dict:
        """Create a new task entry.

        `channel` names the frontend surface the task belongs to (`"grab"`,
        `"release"`, `"copy"`, `"mixer"`) so the SSE event it eventually
        publishes invalidates that surface's query and no other.
        """
        task = {
            "id": task_id,
            "status": "pending",
            "created_at": time.time(),
            "started_at": None,
            "detail": None,
            "cancelled": False,
            "progress": 0,
            "channel": channel,
            **kwargs,
        }
        with self._lock:
            self._tasks[task_id] = task
        return task

    def get(self, task_id: str) -> dict | None:
        """Get a task by ID, cleaning up old completed tasks."""
        self.cleanup()
        with self._lock:
            return self._tasks.get(task_id)

    def update(self, task_id: str, **kwargs) -> None:
        """Update fields on a task.

        The moment a status BECOMES `done` or `error` (the transition, not
        every later refresh of an already-terminal task) an SSE event goes out
        so the waiting query invalidates at once instead of on its next poll.
        Best-effort by design: the bus never raises, and the publish sits
        outside the lock and inside its own try — a dropped event costs one
        polling cycle, never the task itself.
        """
        event: dict | None = None
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return
            was = task.get("status")
            task.update(kwargs)
            if task.get("status") in ("done", "error") and task["status"] != was:
                event = {
                    "kind": "task",
                    "channel": task.get("channel", ""),
                    "task_id": task["id"],
                    "status": task["status"],
                    "detail": task.get("detail"),
                }
        if event is not None:
            try:
                event_bus.publish(event)
            except Exception:  # noqa: BLE001 — publishing must never break a task
                log.debug("task event for %s dropped", task_id, exc_info=True)

    def cancel(self, task_id: str) -> dict:
        """Request cancellation of a task."""
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return {"ok": False, "error": "tarea no encontrada"}
            if task.get("status") not in ("running", "pending", "paused", None):
                return {"ok": False, "error": f"tarea ya en estado: {task['status']}"}
            task["cancelled"] = True
            task["detail"] = "cancelación solicitada..."
        log.info("Task %s cancellation requested", task_id)
        return {"ok": True}

    def is_cancelled(self, task_id: str) -> bool:
        """Check if a task has been cancelled."""
        with self._lock:
            task = self._tasks.get(task_id)
            return bool(task and task.get("cancelled"))

    def cleanup(self) -> int:
        """Remove completed tasks older than TTL. Returns count removed."""
        now = time.time()
        with self._lock:
            to_remove = [
                tid
                for tid, t in self._tasks.items()
                if t.get("status")
                in ("done", "error", "cancelled", "imported", "import_timeout", "renamed_needed")
                and now - t.get("created_at", 0) > self._ttl
            ]
            for tid in to_remove:
                del self._tasks[tid]
        return len(to_remove)

    def all_tasks(self) -> dict[str, dict]:
        """Return a snapshot of all active tasks."""
        self.cleanup()
        with self._lock:
            return {tid: dict(t) for tid, t in self._tasks.items()}


# Shared instances — one for copy operations, one for mux operations
copy_tasks = TaskManager(ttl=600)
mux_tasks = TaskManager(ttl=600)
