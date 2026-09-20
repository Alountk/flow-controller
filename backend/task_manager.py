"""Unified task management for background operations.

Provides a single TaskManager class used by copy_engine and media_mixer.
The file_queue in routes/files.py uses a different pattern (sequential queue)
and stays separate.
"""

import asyncio
import time
import logging

log = logging.getLogger("flow-controller")


class TaskManager:
    """Thread-safe task registry for background operations."""

    def __init__(self):
        self._tasks: dict[str, dict] = {}
        self._lock = asyncio.Lock()

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
        self._tasks[task_id] = task
        return task

    def get(self, task_id: str) -> dict | None:
        """Get a task by ID, cleaning up old completed tasks."""
        self.cleanup()
        return self._tasks.get(task_id)

    def update(self, task_id: str, **kwargs) -> None:
        """Update fields on a task."""
        if task_id in self._tasks:
            self._tasks[task_id].update(kwargs)

    def cancel(self, task_id: str) -> dict:
        """Request cancellation of a task."""
        task = self._tasks.get(task_id)
        if not task:
            return {"ok": False, "error": "tarea no encontrada"}
        if task.get("status") not in ("running", "pending", None):
            return {"ok": False, "error": f"tarea ya en estado: {task['status']}"}
        task["cancelled"] = True
        task["detail"] = "cancelación solicitada..."
        log.info("Task %s cancellation requested", task_id)
        return {"ok": True}

    def is_cancelled(self, task_id: str) -> bool:
        """Check if a task has been cancelled."""
        task = self._tasks.get(task_id)
        return bool(task and task.get("cancelled"))

    def cleanup(self, max_age: float = 3600) -> int:
        """Remove completed tasks older than max_age seconds. Returns count removed."""
        now = time.time()
        to_remove = []
        for tid, t in self._tasks.items():
            if t.get("status") in ("done", "error", "cancelled"):
                created = t.get("created_at", 0)
                if now - created > max_age:
                    to_remove.append(tid)
        for tid in to_remove:
            del self._tasks[tid]
        return len(to_remove)

    def all_tasks(self) -> dict[str, dict]:
        """Return all active tasks."""
        self.cleanup()
        return dict(self._tasks)
