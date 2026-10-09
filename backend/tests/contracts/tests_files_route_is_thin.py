"""T1 acceptance: the file routes carry no placement logic.

The policy moved to `domain.policy.placement` and its orchestration to
`application.use_cases.place_file`. This gate reads the route source the same
way `tests_static` reads it, so a later edit cannot quietly drag a hardlink,
a rename or a copytree back into a handler.
"""

from __future__ import annotations

from tests import BACKEND_ROOT as BACKEND  # noqa: E402

FILES_ROUTE = BACKEND / "interfaces" / "http" / "routes" / "files.py"

#: The placement machinery the routes must not own any more.
FORBIDDEN = (
    "os.rename",
    "os.link",
    "os.remove",
    "copytree",
    "_link_or_copy",
    "shutil.copy2",
    "shutil.rmtree",
    "NamedTemporaryFile",
)


def test_the_file_routes_contain_no_placement_logic():
    source = FILES_ROUTE.read_text(encoding="utf-8")
    found = [token for token in FORBIDDEN if token in source]

    assert not found, (
        "placement policy belongs to domain/application, not to handlers; "
        f"found in routes/files.py: {found}"
    )
