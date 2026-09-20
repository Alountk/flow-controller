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

log = logging.getLogger("flow-controller")


class TaskManager:
    """Thread-safe task registry for background operations."""

    def __init__(self, ttl: float = 600):
        self._tasks: dict[str, dict] = {}
        self._lock = threading.RLock()
        self._ttl = ttl

    def create(self, task_id: str, **kwargs) -> dict:
        """Create a new task entry."""
        task = {
            "id": task_id,
            "status": "pending",
            "created_at": time.time(),
            "started_at": None,
            "detail": None,
            "cancelled": False,
            "progress": 0,
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
        """Update fields on a task."""
        with self._lock:
            if task_id in self._tasks:
                self._tasks[task_id].update(kwargs)

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
