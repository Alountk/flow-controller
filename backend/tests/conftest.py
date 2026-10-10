"""Suite-wide isolation for the HTTP edge budgets (C-05).

The rate limiter is process state on module-level singletons, and every test
talks to the app through the same peer address — without a reset around each
test, one test's requests become another test's 429. The counters are
forgotten before and after each test; the limits themselves are never
touched here (a test that changes a limit owns restoring it).

The store is cleared through the attribute rather than a ``reset()`` method
on purpose: vulture's contract (``tests_static.py``) excludes everything
under ``tests/``, so a helper called ONLY from tests reads as dead code, and
``vulture_whitelist.py`` is outside this change's edit surface. Same pattern
as ``trace_cache._trace_cache = None`` in the route tests.
"""

import pytest


@pytest.fixture(autouse=True)
def _fresh_http_budgets():
    from interfaces.http.middleware import auth_failures, general

    general._counts.clear()
    auth_failures._counts.clear()
    yield
    general._counts.clear()
    auth_failures._counts.clear()
