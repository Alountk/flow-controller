"""Pure placement policy (`domain.policy.placement`) — no HTTP, no disk.

The rules the file routes used to bury in handlers (T1): when placement must
refuse to touch a seeding path, what a byte-move plans itself, what a fallback
move cleans up, how a copy temp is named so its rename is atomic, and how the
queue trims. Every fact arrives as an argument, so each assertion states a
literal outcome rather than re-running the policy.
"""

from __future__ import annotations

from domain.policy import placement

#: The purity check below reads source, so it must read THIS module's bytes.
from tests import BACKEND_ROOT  # noqa: E402

MODULE_PATH = BACKEND_ROOT / "domain" / "policy" / "placement.py"


# ── The seeding path is guarded ──────────────────────────────────────────────


def test_a_file_inside_the_torrent_root_cannot_be_renamed_or_moved():
    reason = placement.seed_block_reason(
        "/mnt/storage/torrents/Movie (2016)/Movie.mkv",
        "/mnt/storage/torrents",
        "mover",
    )

    assert reason is not None
    assert "'Movie.mkv'" in reason
    assert "(/mnt/storage/torrents)" in reason
    assert "no se puede mover" in reason
    assert "semilla" in reason


def test_the_torrent_root_itself_is_guarded():
    reason = placement.seed_block_reason(
        "/mnt/storage/torrents", "/mnt/storage/torrents", "renombrar"
    )

    assert reason is not None
    assert "no se puede renombrar" in reason


def test_a_library_file_is_free_to_move():
    assert (
        placement.seed_block_reason(
            "/mnt/storage/movies/Movie (2016)/Movie.mkv",
            "/mnt/storage/torrents",
            "mover",
        )
        is None
    )


def test_a_sibling_folder_sharing_the_prefix_is_not_guarded():
    """`/torrents-evil` starts with the root's text but is not under it."""
    assert (
        placement.seed_block_reason(
            "/mnt/storage/torrents-evil/Movie.mkv",
            "/mnt/storage/torrents",
            "mover",
        )
        is None
    )


# ── The plan: skip, or hardlink first ────────────────────────────────────────


def test_an_inode_already_shared_at_both_ends_never_moves_a_byte():
    calls: list[bool] = []

    def same_inode() -> bool:
        calls.append(True)
        return True

    plan = placement.placement_plan(True, True, same_inode)

    assert plan == placement.ALREADY_PLACED
    assert len(calls) == 1, "the shared inode must actually be consulted"


def test_the_inode_probe_is_not_asked_when_the_destination_is_missing():
    """`os.path.samefile` raises when a path does not exist — never ask."""
    def same_inode() -> bool:
        raise AssertionError("samefile must not run for a missing destination")

    plan = placement.placement_plan(True, False, same_inode)

    assert plan == placement.HARDLINK_FIRST


def test_two_different_inodes_at_the_ends_plan_a_hardlink():
    plan = placement.placement_plan(True, True, lambda: False)

    assert plan == placement.HARDLINK_FIRST


def test_a_missing_source_plans_a_hardlink_not_a_probe():
    def same_inode() -> bool:
        raise AssertionError("samefile must not run for a missing source")

    assert placement.placement_plan(False, True, same_inode) == placement.HARDLINK_FIRST


# ── Atomic replace: the temp belongs beside its destination ──────────────────


def test_the_temp_file_is_named_beside_the_destination():
    """Same directory → the final rename cannot cross a filesystem."""
    params = placement.atomic_temp_params("/mnt/storage/movies/release.mkv")

    assert params == {"dir": "/mnt/storage/movies", "prefix": ".copy_", "suffix": ".part"}


def test_a_bare_destination_resolves_to_the_working_directory():
    params = placement.atomic_temp_params("release.mkv")

    assert params["dir"] == "."
    assert params["prefix"] == ".copy_"
    assert params["suffix"] == ".part"


# ── A fallback move cleans up only what nobody cancelled ─────────────────────


def test_a_completed_fallback_copy_deletes_the_source():
    assert placement.fallback_source_cleanup(cancelled=False) == placement.DELETE_SOURCE


def test_a_cancelled_fallback_copy_keeps_the_source():
    assert placement.fallback_source_cleanup(cancelled=True) == placement.KEEP_SOURCE


# ── The queue trims past the limit, and only finished work ───────────────────


def _op(status: str) -> dict:
    return {"status": status}


def test_a_queue_at_the_limit_is_left_untouched():
    ops = [_op("done")] * 50

    assert placement.over_queue_limit(ops) is False


def test_one_operation_past_the_limit_triggers_the_trim():
    ops = [_op("done")] * 51

    assert placement.over_queue_limit(ops) is True


def test_the_trim_keeps_only_work_that_still_has_to_run():
    ops = [_op("done"), _op("failed"), _op("cancelled"), _op("pending"), _op("running")]

    assert placement.retained_queue(ops) == [
        {"status": "pending"},
        {"status": "running"},
    ]


# ── Purity: the policy module must stay side-effect free ─────────────────────


def test_the_placement_policy_has_no_side_effect_imports():
    source = MODULE_PATH.read_text(encoding="utf-8")
    forbidden = (
        "aiohttp",
        "from state",
        "from history",
        "from config",
        "import os",
        "import time",
        "import shutil",
        "import tempfile",
    )
    found = [token for token in forbidden if token in source]
    assert not found, (
        "the pure policy must not grow a session, a clock, a disk or "
        f"configuration; found: {found}"
    )
