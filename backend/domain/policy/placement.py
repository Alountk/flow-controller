"""Pure decisions for placing a file — no filesystem, no clock, no config.

The rules the file routes used to bury inside their handlers (T1). Every fact
arrives as an argument — paths already resolved, existence already observed,
the outcome of an attempt already known — so each decision can be pinned by a
test with literals and nothing on disk. The callers in
`application.use_cases.place_file` do the touching; this module only says what
must happen.

One boundary worth stating: the functions here never open, stat or write
anything. Even the inode probe is passed in as a callable so that asking the
question stays this module's decision while the syscall stays the caller's.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

#: The queue accepts operations until it holds this many; past that, finished
#: work is dropped so a long-lived queue cannot grow without bound.
QUEUE_LIMIT = 50

#: The only statuses that still owe the operator an execution.
ACTIVE_QUEUE_STATUSES = frozenset({"pending", "running"})

#: Outcome of `placement_plan`: both ends already name the same inode, so
#: there is nothing to place — and, above all, nothing to WRITE, because
#: opening the shared destination would empty the inode the source still is.
ALREADY_PLACED = "already_placed"

#: Outcome of `placement_plan`: try the hardlink first (instant, free, keeps
#: the download seeding) and pay a real byte copy only when the filesystem
#: refuses the link — an EXDEV cut between devices is the common refusal, and
#: any other OSError buys the same fallback.
HARDLINK_FIRST = "hardlink_first"

#: Outcome of `fallback_source_cleanup` after a failed rename was recovered by
#: a copy: the transfer completed and nobody cancelled, so the source goes.
DELETE_SOURCE = "delete_source"

#: Outcome of `fallback_source_cleanup` when the operator stopped the copy:
#: keep the download exactly where it was.
KEEP_SOURCE = "keep_source"

#: Name of the temporary a copy writes into before its atomic rename. Same
#: directory as the destination is the point: the final rename must never
#: cross a filesystem, or the replace would stop being atomic.
TEMP_PREFIX = ".copy_"
TEMP_SUFFIX = ".part"


def seed_block_reason(resolved_src: str, resolved_torrent_root: str, verb: str) -> str | None:
    """Why `resolved_src` must not be renamed or moved by us — or None when it may.

    A torrent client shares a PATH, not an inode. Renaming or moving a file
    removes the directory entry it is seeding, and the data surviving does not
    help: the seeder's path is what disappeared. Placing an extra name (a
    hardlink or a copy) never touches it, which is why the operations allowed
    here are the ones that ADD a name and not the ones that change one.

    **Only the torrent folder is guarded.** aMule is excluded on purpose, and
    two independent reasons say the same thing:

    - its downloads sit on a *different mount* from the library
      (`/mnt/storage-6tb` vs `/mnt/storage`), so a hardlink between them is
      impossible — there was no hardlink here to protect in the first place;
    - aMule has no seed ratio and no swarm obligation, and an ED2K can be
      fetched again from the network, so a file there is disposable on a
      schedule rather than a fragile seed. Blocking it would protect nothing
      while getting in the way of the retention cleanup.

    Both paths arrive ALREADY resolved (the caller ran the canonicalization
    for both ends): resolution is a syscall, and this module makes decisions,
    not filesystem queries. The folder still comes from settings at the call
    site, so changing it in Configuración moves the guard with it.
    """
    if resolved_src == resolved_torrent_root or resolved_src.startswith(resolved_torrent_root + "/"):
        return (
            f"'{Path(resolved_src).name}' está en la carpeta de descargas de torrents ({resolved_torrent_root}) y no se "
            f"puede {verb}: qBittorrent comparte exactamente esa ruta, y renombrarla o moverla "
            f"rompe el hardlink con el que sigue sembrando. En su lugar, copia o coloca el "
            f"fichero — se resuelve con un enlace duro y la semilla no se entera."
        )
    return None


def placement_plan(
    src_exists: bool,
    dst_exists: bool,
    same_inode: Callable[[], bool],
) -> str:
    """What to do before any byte moves: `ALREADY_PLACED` or `HARDLINK_FIRST`.

    `same_inode` is a probe, not a fact: `os.path.samefile` raises when either
    path is missing, so it is invoked ONLY when both ends exist. Deciding that
    here is the point — a caller that probes eagerly relearns the rule, and a
    caller that forgets to probe empties the shared inode.
    """
    if src_exists and dst_exists and same_inode():
        return ALREADY_PLACED
    return HARDLINK_FIRST


def atomic_temp_params(dst: str) -> dict[str, str]:
    """Where and under what name a copy writes before its final rename.

    The temp lives in the destination's own directory: a rename within one
    directory is atomic on any filesystem, so a failure mid-transfer can never
    publish a half-written file under the real name. The `.part` suffix keeps
    the temp recognizably incomplete to anything browsing the folder.
    """
    return {"dir": str(Path(dst).parent), "prefix": TEMP_PREFIX, "suffix": TEMP_SUFFIX}


def fallback_source_cleanup(*, cancelled: bool) -> str:
    """After a copy recovered a failed rename: does the source go away?

    A rename removes its source as part of the operation; the copy fallback
    cannot, so the deletion is a separate, deliberate second step. It runs only
    when the transfer finished and nobody cancelled — an operator who stopped
    the copy keeps the download exactly where it was.
    """
    return KEEP_SOURCE if cancelled else DELETE_SOURCE


def over_queue_limit(ops: list, limit: int = QUEUE_LIMIT) -> bool:
    """Whether the queue has grown past what it may keep."""
    return len(ops) > limit


def retained_queue(ops: list) -> list:
    """What an over-limit queue keeps: only work that still has to run.

    Finished rows (`done`, `failed`, `cancelled`) are history — they are read
    from the durable record, not from the live queue — so they are what a trim
    drops. Pending and running operations are never discarded: the operator
    asked for them and they have not been executed yet.
    """
    return [op for op in ops if op["status"] in ACTIVE_QUEUE_STATUSES]
