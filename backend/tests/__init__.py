"""The backend test package.

`BACKEND_ROOT` / `REPO_ROOT` live here because five test files derive paths from
`__file__`, and every one of them assumed the file sat directly in `backend/`.
Once the tests move into a tree, `Path(__file__).resolve().parent` stops being
`backend/` and those derivations break silently — a test that can no longer find
`Dockerfile` or `domain/policy.py` fails with an error that says nothing about
where the test itself went. Importing the roots keeps the assumption in one
place instead of five.
"""

import pathlib

BACKEND_ROOT = pathlib.Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_ROOT.parent
