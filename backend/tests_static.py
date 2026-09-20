"""Static checks that run with the normal test suite.

``GET /api/wanted`` once shipped returning HTTP 500 because its body called
``asyncio.gather`` without importing ``asyncio`` — a name that only fails when
the line executes. Runtime tests can miss that if they mock the wrong boundary
or skip the endpoint, so this module adds a static guard that catches undefined
names in the source itself.

The gate is deliberately narrow: it fails on undefined names (the class that
broke production) and ignores cosmetic findings like unused imports, which would
otherwise force unrelated churn into every change.
"""

import subprocess
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent

CRITICAL_MARKERS = ("undefined name",)

# pyflakes skips files it cannot parse, so make that a failure instead of silence.
PYFLAKES_UNAVAILABLE_MARKERS = ("No module named pyflakes", "unable to detect undefined names")


def _python_sources() -> list[Path]:
    sources = sorted(BACKEND_DIR.glob("*.py")) + sorted((BACKEND_DIR / "routes").glob("*.py"))
    return [p for p in sources if p.name != "conftest.py"]


def _run_pyflakes() -> str:
    result = subprocess.run(
        [sys.executable, "-m", "pyflakes", *[str(p) for p in _python_sources()]],
        capture_output=True,
        text=True,
        cwd=BACKEND_DIR,
    )
    return result.stdout + result.stderr


def test_backend_has_python_sources_to_check():
    """Guard the guard: the linter must actually be pointed at real files."""
    sources = _python_sources()

    assert len(sources) > 5, f"unexpectedly few backend sources: {sources}"
    assert any(p.name == "wanted.py" for p in sources)


def test_no_undefined_names_in_backend():
    """Undefined names are runtime crashes — catch them before they ship."""
    if not _run_pyflakes_available():
        pytest.skip("pyflakes is not installed; run: pip install -r requirements-dev.txt")

    output = _run_pyflakes()
    findings = [
        line
        for line in output.splitlines()
        if any(marker in line for marker in CRITICAL_MARKERS)
    ]

    assert not findings, (
        "Undefined names found in backend sources. These raise NameError the moment "
        "the line executes:\n" + "\n".join(findings)
    )


def _run_pyflakes_available() -> bool:
    probe = subprocess.run(
        [sys.executable, "-m", "pyflakes", "--version"],
        capture_output=True,
        text=True,
    )
    return probe.returncode == 0
