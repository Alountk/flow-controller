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
from typing import Callable, Protocol, runtime_checkable


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
