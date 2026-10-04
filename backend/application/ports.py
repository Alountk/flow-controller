"""The contracts the application layer speaks through.

A port is what a use case needs, expressed so that the need is the only thing it
knows. Everything that actually happens — a filesystem, an HTTP client, a
database — lives behind one of these in `infrastructure`, and the composition
root is the only place that knows which implementation met which port.

Nothing here imports anything. That is the point: a use case that only knows
this module can be tested without a disk, a network or a Radarr.

The ports arrive one at a time, beside the use case that needs them. This one
came first because it was already almost a port — a copy that reports progress
and can be interrupted is a contract in every shape but the type.
"""

from __future__ import annotations

from pathlib import Path
from typing import Awaitable, Callable, Protocol, runtime_checkable


class CopyCancelled(Exception):
    """The operator stopped a copy before it finished.

    An outcome, not a fault: nothing is wrong, someone changed their mind. It
    is raised from inside the transfer and caught where the work is coordinated,
    so a cancelled copy cleans its temporary file and leaves no half-written
    destination behind.
    """


@runtime_checkable
class FileStorage(Protocol):
    """Bytes from one place to another, with the operator in control.

    Progress and cancellation are parameters rather than imports on purpose:
    this is the whole reason a copy can run without a task manager attached,
    which is what makes it testable and what keeps `infrastructure` from
    knowing that the app tracks tasks at all.
    """

    def copy_file(
        self,
        src: Path,
        dst: Path,
        *,
        is_cancelled: Callable[[], bool] | None = None,
        on_progress: Callable[[int], None] | None = None,
    ) -> int:
        """Put `src` at `dst` and return the number of bytes written.

        `dst` must not already exist as a directory. On any failure the
        destination is left untouched: a half-copied file is written under a
        temporary name and only renamed into place once it is complete, so an
        interrupted copy cannot be mistaken for a finished one.

        `on_progress` receives the bytes written so far by this call, and is
        called after each chunk — never with the total across several files,
        because a transfer has no idea whether it is one of many.

        Raises `CopyCancelled` when `is_cancelled` turns true mid-stream. The
        temporary file is removed before it propagates.
        """
        ...


# ── The auto-copy sweep ───────────────────────────────────────────────────────
#
# These are named from what the sweep needs, not from the module that happens to
# provide them today. `OwnGrabStore` is one port and not six because the six
# methods are one cohesive record of "what did we ask for, and what became of
# it" — splitting them would leak the shape of a table into a use case that
# only cares that the question has an answer.
#
# The one-shot collaborators are callables rather than protocols on purpose: a
# single function is the honest type for a single question. A Protocol with one
# `__call__` would be ceremony, and it would hide that these arrive as plain
# functions the composition root can bind to anything.


#: Build the traces the sweep judges — one per live download.
TraceLoader = Callable[..., Awaitable[list[dict]]]


#: Does the arr already hold this item? `None` on any doubt — never "no file".
ArrProbe = Callable[..., Awaitable[bool | None]]


#: Root folders the arr manages for a source; ``[]`` whenever unknown.
ArrRoots = Callable[..., Awaitable[list[str]]]


#: Run a named action (`copy_files`, …) and report what happened.
ActionDispatcher = Callable[..., Awaitable[dict]]


@runtime_checkable
class OwnGrabStore(Protocol):
    """What this app asked for, and what became of it.

    Six questions, one record. The sweep reads it to decide whether a download
    is ours, and writes it so a later sweep does not repeat itself.
    """

    def list_own_grabs(self, since: float, *, limit: int = 500) -> list[dict]:
        ...

    def is_auto_copy_handled(self, key: str) -> bool:
        """Whether an earlier sweep already claimed this one."""

    def mark_auto_copy(
        self, key: str, *, source: str, title: str | None, decision: str, reason: str | None = None
    ) -> None:
        """Record an outcome. Claiming happens BEFORE acting, never after."""

    def note_auto_copy_seen(self, key: str, stage: str, *, seen_at: float | None = None) -> float:
        """Return the instant this stage was first observed.

        The trace's only timestamp is the grab instant, which predates the
        download: deriving the grace window from it would start the clock
        before completion and race the arr. So the app keeps its own.
        """

    def latest_auto_copy_decisions(self) -> dict[str, str]:
        """Last logged outcome per key, read once for the whole sweep."""

    def log_auto_copy_decision(
        self, key: str, *, source: str, title: str | None, decision: str, reason: str | None = None
    ) -> None:
        """Append to the "why not" log. History, not state: blocks nothing."""


#: Judge one trace and return its summary line.
TraceHandler = Callable[..., Awaitable[dict]]
