"""The filesystem's answers for the storage report — facts, not decisions.

Behind `application.ports.SystemProbe`: the mount rule, the percent and the
user-facing wording all live in `application.use_cases.disk_report`; this
adapter only performs the syscalls, so `interfaces` never imports it — the
composition root puts it in the use case's hand through `gateways.bind`.
"""

from __future__ import annotations

import os
import shutil

from application.ports import DiskUsage


def disk_usage(path: str) -> DiskUsage:
    """Bytes on the filesystem that contains `path`. Raises OSError if unreadable."""
    return shutil.disk_usage(path)


def exists(path: str) -> bool:
    """Whether `path` exists — the fact the mount rule asks before ismount."""
    return os.path.exists(path)


def ismount(path: str) -> bool:
    """Whether `path` is a mount point — False rather than raising for most misses."""
    return os.path.ismount(path)
