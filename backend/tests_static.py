"""Static checks that run with the normal test suite.

Two complementary gates:

- **pyflakes** — undefined names (runtime ``NameError``), unused imports and
  unused locals. It does NOT understand unused functions or classes.
- **vulture** — dead functions, classes, methods, attributes and variables,
  including the case that motivated it: `_detect_languages_from_alt_titles` and
  `_get_wanted_movies_with_alt_titles` were broken stubs nothing called, and
  pyflakes could not see them.

Both must stay clean. See `vulture_whitelist.py` for the few intentional
exceptions, each with a written reason.
"""

import subprocess
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent
WHITELIST = BACKEND_DIR / "vulture_whitelist.py"


def _run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", *args],
        capture_output=True,
        text=True,
        cwd=BACKEND_DIR,
    )


def _output(result: subprocess.CompletedProcess) -> str:
    return (result.stdout + result.stderr).strip()


def _tool_available(module: str) -> bool:
    return _run(module, "--version").returncode == 0


# ── Coverage of the guards themselves ─────────────────────────────────────────


def _python_sources() -> list[Path]:
    """Backend sources for pyflakes.

    `vulture_whitelist.py` is excluded on purpose: a vulture whitelist is Python
    used purely as configuration, made of deliberately bare name references that
    pyflakes reports as undefined names. It is not source code.
    """
    sources = sorted(BACKEND_DIR.glob("*.py")) + sorted((BACKEND_DIR / "routes").glob("*.py"))
    excluded = {"conftest.py", "vulture_whitelist.py"}
    return [p for p in sources if p.name not in excluded]


def test_backend_has_python_sources_to_check():
    """Guard the guard: the linters must actually be pointed at real files."""
    sources = _python_sources()

    assert len(sources) > 5, f"unexpectedly few backend sources: {sources}"
    assert any(p.name == "wanted.py" for p in sources)
    assert any(p.name == "copy_engine.py" for p in sources)


def test_vulture_config_and_whitelist_exist():
    """Without these, vulture reports every FastAPI handler and the gate is noise."""
    config = BACKEND_DIR / "pyproject.toml"

    assert config.is_file(), "backend/pyproject.toml with [tool.vulture] is missing"
    assert "[tool.vulture]" in config.read_text()
    assert WHITELIST.is_file(), "vulture_whitelist.py is missing"


# ── pyflakes ──────────────────────────────────────────────────────────────────


def test_backend_is_pyflakes_clean():
    """Any pyflakes finding fails: the backend is kept clean, not mostly clean."""
    if not _tool_available("pyflakes"):
        pytest.skip("pyflakes is not installed; run: pip install -r requirements-dev.txt")

    result = _run("pyflakes", *[str(p) for p in _python_sources()])

    assert result.returncode == 0, (
        "pyflakes found problems. Undefined names raise NameError when the line "
        "executes; unused imports and variables are dead weight that hides real "
        "findings:\n" + _output(result)
    )


# ── vulture ───────────────────────────────────────────────────────────────────


def test_backend_has_no_dead_code():
    """Any vulture finding fails. Whitelisted exceptions carry a written reason."""
    if not _tool_available("vulture"):
        pytest.skip("vulture is not installed; run: pip install -r requirements-dev.txt")

    result = _run("vulture")

    assert result.returncode == 0, (
        "vulture found dead code (functions, classes, methods or variables that "
        "nothing calls). Delete it, or add it to vulture_whitelist.py with a "
        "reason:\n" + _output(result)
    )


def test_vulture_is_actually_scanning_the_backend():
    """Guard the guard: a clean report is worthless if nothing was scanned.

    Disabling `ignore_decorators` must surface the FastAPI handlers that vulture
    cannot see as used. If this finds nothing, the path/confidence config is
    broken and `test_backend_has_no_dead_code` is passing vacuously.
    """
    if not _tool_available("vulture"):
        pytest.skip("vulture is not installed; run: pip install -r requirements-dev.txt")

    result = _run("vulture", "--ignore-decorators", "")

    assert "unused function" in _output(result), (
        "vulture reported nothing even with decorator ignoring disabled — it is "
        "not scanning the backend, so the clean result above proves nothing:\n"
        + _output(result)
    )
