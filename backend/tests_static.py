"""Static checks that run with the normal test suite.

``GET /api/wanted`` once shipped returning HTTP 500 because its body called
``asyncio.gather`` without importing ``asyncio`` — a name that only fails when
the line executes. Runtime tests can miss that if they mock the wrong boundary
or skip the endpoint, so this module adds a static guard that catches problems
in the source itself.

The whole backend is pyflakes-clean, so this gate is deliberately strict: any
pyflakes finding fails the suite. Undefined names are runtime crashes; unused
imports and variables are dead weight that hides real findings.
"""

import subprocess
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent


def _python_sources() -> list[Path]:
    sources = sorted(BACKEND_DIR.glob("*.py")) + sorted((BACKEND_DIR / "routes").glob("*.py"))
    return [p for p in sources if p.name != "conftest.py"]


def _pyflakes_available() -> bool:
    probe = subprocess.run(
        [sys.executable, "-m", "pyflakes", "--version"],
        capture_output=True,
        text=True,
    )
    return probe.returncode == 0


def _run_pyflakes() -> str:
    result = subprocess.run(
        [sys.executable, "-m", "pyflakes", *[str(p) for p in _python_sources()]],
        capture_output=True,
        text=True,
        cwd=BACKEND_DIR,
    )
    return (result.stdout + result.stderr).strip()


def test_backend_has_python_sources_to_check():
    """Guard the guard: the linter must actually be pointed at real files."""
    sources = _python_sources()

    assert len(sources) > 5, f"unexpectedly few backend sources: {sources}"
    assert any(p.name == "wanted.py" for p in sources)
    assert any(p.name == "copy_engine.py" for p in sources)


def test_backend_is_pyflakes_clean():
    """Any pyflakes finding fails: the backend is kept clean, not mostly clean."""
    if not _pyflakes_available():
        pytest.skip("pyflakes is not installed; run: pip install -r requirements-dev.txt")

    findings = _run_pyflakes()

    assert not findings, (
        "pyflakes found problems in the backend sources. Undefined names raise "
        "NameError when the line executes; unused imports and variables are dead "
        "weight that hides real findings:\n" + findings
    )
