"""The filesystem behind `application.ports.FileStorage`.

Hardlink first — instant, free, and it keeps a seeding download sharing the one
inode — then a chunked copy through a temporary file that is renamed into place
only when it is whole. `os.rename` is atomic on the same filesystem, so the
destination either does not exist or is complete; nothing else has to know that
a copy was interrupted to avoid reading half a file.

This module owns how bytes move and nothing else. It does not know what a task
is, who is watching a progress bar, or why a file is being copied. Those are
the caller's business and they arrive as two optional callables.
"""

from __future__ import annotations

import errno
import logging
import os
import tempfile
from pathlib import Path
from typing import Callable

from application.ports import CopyCancelled

log = logging.getLogger("flow-controller")

#: 1 MB. Large enough that per-chunk overhead disappears, small enough that a
#: progress bar moves for a file a person is actually waiting on.
COPY_CHUNK_SIZE = 1024 * 1024


class LocalFileStorage:
    """`FileStorage` over a POSIX filesystem."""

    def copy_file(
        self,
        src: Path,
        dst: Path,
        *,
        is_cancelled: Callable[[], bool] | None = None,
        on_progress: Callable[[int], None] | None = None,
    ) -> int:
        try:
            os.link(src, dst)
            return src.stat().st_size
        except OSError as exc:
            if exc.errno == errno.EXDEV:
                # Expected: source and destination live on different filesystems.
                log.debug("copy_file: %s and %s are on different filesystems, copying", src, dst)
            else:
                log.warning(
                    "copy_file: hardlink failed (errno %s %s) for %s, falling back to copy",
                    exc.errno,
                    errno.errorcode.get(exc.errno, "unknown"),
                    src,
                )

        written = 0
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(dir=dst.parent, delete=False, prefix=".copy_") as fdst:
                tmp_path = fdst.name
                with open(src, "rb") as fsrc:
                    while True:
                        if is_cancelled and is_cancelled():
                            raise CopyCancelled(f"cancelado durante copia de {src.name}")
                        chunk = fsrc.read(COPY_CHUNK_SIZE)
                        if not chunk:
                            break
                        fdst.write(chunk)
                        written += len(chunk)
                        if on_progress:
                            on_progress(written)
            os.rename(tmp_path, str(dst))
            tmp_path = None
        except Exception:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)
            raise
        return written


#: The one the composition root hands to use cases. Tests can build their own.
storage = LocalFileStorage()
