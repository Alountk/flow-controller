"""T3 gates — typed ports at the seam, thin routes behind it.

Four rules the refactor earns, read from the source the same way
`tests_files_route_is_thin` reads its route:

1. `application.gateways` must not resolve bindings dynamically
   (`__getattr__` + `ModuleType`): a binding that misses a name only failed
   when a request reached for it. The slots are declared, typed attributes
   now, and `bind` validates them against the ports in `application.ports`.
2. The API-key dependency belongs to `interfaces/http/deps.py`, not to one
   route module that seven other routes import from.
3. No route reaches into another route's `_private` name — shared behaviour
   lives in a module both may import (`route_helpers.py`).
4. Probes (`shutil.disk_usage`, `os.walk`) are infrastructure: the syscall
   may not appear in a handler. The use case accepts injected callables; the
   adapter lives in `infrastructure/`.
"""

from __future__ import annotations

import ast
import importlib

from tests import BACKEND_ROOT as BACKEND  # noqa: E402

GATEWAYS = BACKEND / "application" / "gateways.py"
ROUTES_DIR = BACKEND / "interfaces" / "http" / "routes"
HTTP_DIR = BACKEND / "interfaces" / "http"


def _sources(paths) -> list[tuple[str, str]]:
    return [(p.name, p.read_text(encoding="utf-8")) for p in sorted(paths)]


# ── 1. No dynamic binding in gateways ────────────────────────────────────────


def test_gateways_never_resolves_binding_dynamically():
    tree = ast.parse(GATEWAYS.read_text(encoding="utf-8"))

    getattr_defs = [
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == "__getattr__"
    ]
    module_type_imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            module_type_imports += [
                alias.name
                for alias in node.names
                if alias.name == "types" or alias.name.endswith(".ModuleType")
            ]
        elif isinstance(node, ast.ImportFrom):
            if node.module in ("types",) or (node.module or "").endswith(".types"):
                module_type_imports += [
                    alias.name for alias in node.names if alias.name == "ModuleType"
                ]

    assert not getattr_defs and not module_type_imports, (
        "gateways must declare its adapters as typed port attributes and validate "
        "them at bind time; a module-level __getattr__ or ModuleType slot defers a "
        f"mis-binding until the first request reaches for the name "
        f"(getattr defs: {getattr_defs}, ModuleType imports: {module_type_imports})"
    )


# ── 2. The auth dependency lives in deps.py ──────────────────────────────────


def test_the_auth_dependency_lives_in_deps():
    deps = importlib.import_module("interfaces.http.deps")

    assert hasattr(deps, "verify_api_key"), (
        "verify_api_key belongs to the shared dependency module, not to a route"
    )


# ── 3. No route imports another route's private name ─────────────────────────


def _clean(rel) -> tuple[str, ...]:
    parts = rel.parts
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return parts


def test_no_route_imports_another_routes_private_name():
    offenders: list[str] = []
    route_files = list(ROUTES_DIR.glob("*.py")) + [HTTP_DIR / "routes_mixer.py"]

    for path in route_files:
        rel = path.relative_to(BACKEND).with_suffix("")
        own = ".".join(_clean(rel))
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or not node.module:
                continue
            if not node.module.startswith("interfaces.http.routes"):
                continue
            if node.module == own:
                continue
            for alias in node.names:
                if alias.name.startswith("_"):
                    offenders.append(
                        f"  {path.name}:{node.lineno}: imports {alias.name} from {node.module}"
                    )

    assert not offenders, (
        "a route must not reach into another route's private name; move the "
        "shared behaviour to interfaces/http/route_helpers.py instead:\n"
        + "\n".join(offenders)
    )


# ── 4. No probe syscalls in handlers ─────────────────────────────────────────

#: The infrastructure probes the routes must not own any more.
PROBE_TOKENS = ("disk_usage", "os.walk")


def test_the_routes_contain_no_probe_syscalls():
    offenders: list[str] = []
    for name, source in _sources(ROUTES_DIR.glob("*.py")):
        for token in PROBE_TOKENS:
            if token in source:
                offenders.append(f"  {name}: {token}")

    assert not offenders, (
        "probes belong behind an application use case with the syscall in "
        "infrastructure, not in a handler:\n" + "\n".join(offenders)
    )
