"""`disk_report` — the storage page's entries, decided away from the handler.

The route used to inline `shutil.disk_usage`, the mount check and the percent
math, so the only way to test any of it was through HTTP with the real
filesystem. Here the probe is injected: a scripted filesystem makes every
branch — measured, foreign, unreadable — a deterministic assertion on the exact
payload the endpoint has always returned.
"""

from __future__ import annotations

from types import SimpleNamespace

from application.use_cases.disk_report import disk_report, is_foreign_filesystem, volume_name


class _Probe:
    """A scripted filesystem: every question has a pre-arranged answer."""

    def __init__(self, *, total=0, used=0, free=0, exists=True, ismount=True, error=None):
        self._usage = SimpleNamespace(total=total, used=used, free=free)
        self._exists = exists
        self._ismount = ismount
        self._error = error

    def disk_usage(self, path):
        if self._error is not None:
            raise self._error
        return self._usage

    def exists(self, path):
        return self._exists

    def ismount(self, path):
        return self._ismount


def test_a_measured_mount_reports_its_usage():
    probe = _Probe(total=1000, used=250, free=750)

    body = disk_report(["/data"], probe=probe)

    assert body == {
        "volumes": [
            {
                "name": "data",
                "path": "/data",
                "total_bytes": 1000,
                "used_bytes": 250,
                "free_bytes": 750,
                "percent": 25.0,
            }
        ]
    }


def test_a_path_that_is_not_a_mount_reports_no_numbers():
    """The 63 GB rootfs lesson: real numbers under a foreign label is the bug."""
    probe = _Probe(total=63_000_000_000, used=10, free=10, ismount=False)

    entry = disk_report(["/data/custom-storage"], probe=probe)["volumes"][0]

    assert entry["total_bytes"] == 0
    assert entry["percent"] == 0
    assert "montaje" in entry["error"]


def test_an_unreadable_filesystem_reports_no_disponible():
    probe = _Probe(ismount=True, error=OSError("stale mount"))

    entry = disk_report(["/gone"], probe=probe)["volumes"][0]

    assert entry["error"] == "no disponible"
    assert entry["total_bytes"] == 0


def test_no_roots_reports_no_volumes():
    assert disk_report([], probe=_Probe()) == {"volumes": []}


def test_a_missing_path_is_not_foreign():
    """Absence has its own message; conflating it with "not a mount" hides it."""
    assert is_foreign_filesystem("/definitely/not/here", probe=_Probe(exists=False)) is False


def test_a_plain_directory_is_foreign():
    assert is_foreign_filesystem("/somewhere", probe=_Probe(exists=True, ismount=False)) is True


def test_a_mount_point_is_not_foreign():
    assert is_foreign_filesystem("/", probe=_Probe(exists=True, ismount=True)) is False


def test_the_volume_name_is_the_last_path_component():
    assert volume_name("/mnt/storage") == "storage"
    assert volume_name("/mnt/backup/") == "backup"
    assert volume_name("/") == "/"
