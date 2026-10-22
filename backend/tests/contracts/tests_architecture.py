"""Architecture rules — the dependency direction IS the design.

These tests are static: they parse the sources and never import the app. They
exist so a later refactor cannot quietly reverse a dependency, which is exactly
the failure mode a flat package makes invisible.

Layers, outermost last::

    domain            pure policy and value objects — no I/O at all
    application       use cases and the PORTS they speak through
    infrastructure    adapters behind those ports (HTTP clients, SQLite, FS)
    interfaces        delivery (HTTP routes) — talks to ports, never adapters

The rule: a layer may only depend on itself and on layers further in. The one
that earns the whole exercise is `interfaces` never importing `infrastructure`,
because that is what leaves the wiring to the composition root and lets the
routes be tested without a real Radarr behind them.

Everything outside the four is `legacy` — the queue still waiting to migrate.
Layered code may reach into it (that debt is allowed, it is the point of a
step-by-step move) but the debt itself may never GROW: the ratchet below counts
legacy SOURCE LINES, and it only goes down. It counts lines rather than files on
purpose — a module that moves leaves a three-line re-export behind so nothing
breaks, and a file counter would sit still for the whole migration while the
shim kept the old name alive.
"""

from __future__ import annotations

import ast
import pathlib

from tests import BACKEND_ROOT as BACKEND  # noqa: E402

LAYERS = ("domain", "application", "infrastructure", "interfaces")

#: A layer may import itself plus these (inward only).
ALLOWED_INWARD: dict[str, set[str]] = {
    "domain": {"domain"},
    "application": {"domain", "application"},
    "infrastructure": {"domain", "application", "infrastructure"},
    # Hexagonal: delivery speaks to ports. If a route needs an adapter, the
    # composition root injected the wrong thing.
    "interfaces": {"domain", "application", "interfaces"},
}

#: Ratchet — source lines still outside the four layers, tests excluded. It may
#: only go DOWN as the migration moves code in. Lower it in the same PR that
#: moves code. Raising it is taking on debt on purpose: allowed, but it is a
#: decision that PR has to own and explain, not a constant to nudge past CI.
#: Current debt: `app.py` (the composition root) grows two lines whenever a
#: router is registered — that pair is wiring, not migration debt, and it is
#: why this sits above what the migration itself left behind.
#: 2578 -> 2730 (sse-events): `event_bus.py` is a new top-level module — the
#: one place a bus reachable FROM task_manager (legacy), the application use
#: cases, AND the routes can live without a layer pointing outward; plus one
#: router-registration line in `app.py`. Owned by the sse-events PR.
#: 2730 -> 2750 (sse-poll-off B2): `subscriber_count` on the bus (it must stay
#: top-level for the same no-cycle reason above) and the `trace_refresher`
#: entry in the lifespan tuple of `app.py`. Owned by the sse-poll-off PR.
#: 2750 -> 2751 (stitch-actividad T1): the `activity_router` registration in
#: `app.py` — its import line (+1; the tuple entry fit on the existing line).
#: Router wiring, not migration debt. Owned by the stitch-actividad PR.
#: 2751 -> 2782 (mixer-redesign T3 / S4): the cross-file best-video ranking
#: (`_video_rank_key`, rewritten `select_best_video`, `select_best_video_pair`)
#: in `media_mixer.py` — the mixer still lives in the legacy module. New
#: feature code, disclosed as debt in the mixer-redesign PR description.
#: 2782 -> 2869 (mixer-redesign T4 / S2): language normalization, audio ordering and required-language check in media_mixer.py. Disclosed as debt in the mixer-redesign PR.
#: 2869 -> 3016 (mixer-redesign T5 / S6): subtitle stream parsing and .srt sidecar extraction in media_mixer.py. Disclosed as debt in the mixer-redesign PR.
#: 3016 -> 3017 (mixer-redesign T6 / S6): the `opensubtitles=opensubtitles_client` binding line in `app.py` — composition-root wiring, like every router registration (the import name fit on the existing line). Disclosed as debt in the mixer-redesign PR.
#: 3017 -> 3218 (mixer-redesign T12 / S11): the serial mux queue (one mux at a
#: time, `queued` FIFO with slot release), destination substitution (hidden
#: same-directory temp + atomic `os.replace` after subtitle extraction) and
#: the two-stream ffmpeg progress reader in `media_mixer.py` (+197), plus
#: `queued` as a cancellable live state in `task_manager.py` (+4). Disclosed
#: as debt in the mixer-redesign PR description.
#: 3254 -> 3268 (busqueda-idioma-prowlarr T1 / S6): the `prowlarr` service in
#: `config.py` — its settings reads and its SERVICES entry (+14). Service
#: config lives in the legacy module because the radarr precedent lives there
#: too; new feature code, disclosed as debt in the busqueda-idioma-prowlarr
#: PR description.
#: 3268 -> 3270 (busqueda-idioma-prowlarr T2 / S6): the `prowlarr` adapter
#: import and its `gateways.bind` entry in `app.py` (+2). Composition-root
#: wiring, the exact `opensubtitles` precedent — the adapter itself lives in
#: `infrastructure/prowlarr_client.py` behind the `ProwlarrClient` port, so
#: this is wiring, not migration debt. Disclosed as debt in the
#: busqueda-idioma-prowlarr PR description.
MAX_LEGACY_LOC = 3270


def _is_ignored(rel: pathlib.PurePath) -> bool:
    return any(part in ("__pycache__", ".git") for part in rel.parts)


def _module_names() -> set[str]:
    """Every importable module and package name under `backend/`."""
    names: set[str] = set()
    for path in BACKEND.rglob("*.py"):
        rel = path.relative_to(BACKEND)
        if _is_ignored(rel):
            continue
        parts = rel.with_suffix("").parts
        if parts[-1] == "__init__":
            parts = parts[:-1]
        for i in range(1, len(parts) + 1):
            names.add(".".join(parts[:i]))
    return names


def _layer_of(module: str) -> str:
    top = module.split(".")[0]
    if top in LAYERS:
        return top
    return "legacy"


def _is_test(module: str) -> bool:
    top = module.split(".")[0]
    name = module.rsplit(".", 1)[-1]
    return top.startswith("tests") or name in ("conftest", "vulture_whitelist")


def _local_imports(path: pathlib.Path, local: set[str]) -> list[tuple[int, str]]:
    """[(lineno, module)] for every import that resolves inside `backend/`."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except SyntaxError as exc:  # pragma: no cover - a broken file is a real bug
        raise AssertionError(f"{path}: cannot parse ({exc})") from exc

    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in local:
                    found.append((node.lineno, alias.name))
                elif alias.name.split(".")[0] in local:
                    found.append((node.lineno, alias.name.split(".")[0]))
        elif isinstance(node, ast.ImportFrom):
            # `from . import x` / relative imports resolve against the file.
            if node.level:
                here = path.relative_to(BACKEND).with_suffix("")
                base = here.parts[: len(here.parts) - node.level]
                target = ".".join(base + tuple((node.module or "").split(".")))
                target = target.strip(".")
                if target in local:
                    found.append((node.lineno, target))
                continue
            if node.module and node.module in local:
                found.append((node.lineno, node.module))
            elif node.module and node.module.split(".")[0] in local:
                found.append((node.lineno, node.module.split(".")[0]))
    return found


def _collect() -> tuple[list[tuple[pathlib.Path, int, str, str, str]], int]:
    """(violations, legacy_source_lines).

    Each violation is (file, lineno, imported, from_layer, to_layer).
    """
    local = _module_names()
    violations: list[tuple[pathlib.Path, int, str, str, str]] = []
    legacy_loc = 0

    for path in sorted(BACKEND.rglob("*.py")):
        rel = path.relative_to(BACKEND)
        if _is_ignored(rel):
            continue
        parts = rel.with_suffix("").parts
        if parts[-1] == "__init__":
            parts = parts[:-1]
        if not parts:  # backend/__init__.py or similar
            continue
        module = ".".join(parts)
        if _is_test(module):
            continue

        owner_layer = _layer_of(module)
        if owner_layer == "legacy":
            legacy_loc += len(path.read_text(encoding="utf-8").splitlines())

        allowed = ALLOWED_INWARD.get(owner_layer)
        if allowed is None:
            continue  # legacy: unrestricted while it migrates

        for lineno, imported in _local_imports(path, local):
            if _is_test(imported):
                continue
            target_layer = _layer_of(imported)
            if target_layer == "legacy":
                continue  # debt, allowed — it is the queue
            if target_layer not in allowed:
                violations.append((path, lineno, imported, owner_layer, target_layer))

    return violations, legacy_loc


def test_the_dependency_rule_points_inward_only():
    violations, _ = _collect()
    if violations:
        lines = [
            f"  {path.relative_to(BACKEND)}:{lineno}: {owner} -> {imported} ({target})"
            f"  allowed: {sorted(ALLOWED_INWARD[owner])}"
            for path, lineno, imported, owner, target in violations
        ]
        raise AssertionError(
            "A layer imported something outside itself, pointing outward:\n"
            + "\n".join(lines)
        )


def test_interfaces_never_reach_past_the_ports():
    """The one rule the whole exercise buys.

    A route that imports an adapter has the composition root inject the wrong
    thing, and the routes stop being testable without the real services.
    """
    local = _module_names()
    offenders = []
    for path in sorted((BACKEND / "interfaces").rglob("*.py")):
        rel = path.relative_to(BACKEND)
        if _is_ignored(rel):
            continue
        for lineno, imported in _local_imports(path, local):
            if _layer_of(imported) == "infrastructure":
                offenders.append(f"  {rel}:{lineno}: {imported}")
    if offenders:
        raise AssertionError(
            "Delivery code imports an adapter. Inject a port instead:\n"
            + "\n".join(offenders)
        )


def test_the_legacy_debt_only_shrinks():
    _, legacy_loc = _collect()
    if legacy_loc > MAX_LEGACY_LOC:
        raise AssertionError(
            f"Legacy source went from {MAX_LEGACY_LOC} lines up to {legacy_loc}. "
            "If this PR moved code, lower MAX_LEGACY_LOC to match. If it added "
            "new legacy code, raising it is debt on purpose — own that in the PR "
            "description rather than leaving the constant quietly behind."
        )
