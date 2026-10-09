"""Storage report — which volumes exist, and what they are actually holding.

One module for the probe work that used to live inside the HTTP handler of
`interfaces/http/routes/calendar.py` (T3): the route parses nothing here — it
hands the configured roots and the injected `SystemProbe`, and maps the
returned dict to its response unchanged. The syscalls themselves belong to
`infrastructure.system_probe`; what this module owns is the DECISIONS: which
path counts as its own filesystem, what a failure reports, and the wording the
page has always shown.

Behaviour is the route's behaviour, kept byte for byte: the mount-point rule
that stopped a plain directory from masquerading as a "Storage (6TB)" volume,
the honest "no disponible" of an unreadable filesystem, and the percent the
frontend draws.
"""

from __future__ import annotations

import os

from application.ports import SystemProbe


def is_foreign_filesystem(path: str, *, probe: SystemProbe) -> bool:
    """Whether ``path`` is NOT its own filesystem — i.e. is not a mount point.

    ``disk_usage`` measures the filesystem that *contains* a path, so a
    plain directory answers with whatever holds it. That is how a folder on the
    app's own 63 GB rootfs was served as a working "Storage (6TB)" volume: the
    number was real, the label was not, and nothing on the way told them apart.

    A path that does not exist is deliberately NOT foreign. It is a different
    failure with a different message — "no existe" and "no es un montaje" are
    not the same answer, and hiding one behind the other loses information.
    (`ismount` answers ``False`` for a missing path rather than
    raising, so existence has to be asked first.)
    """
    if not probe.exists(path):
        return False
    try:
        return not probe.ismount(path)
    except OSError:
        return False


def volume_name(path: str) -> str:
    """A label that claims nothing.

    The old endpoint invented ``Storage (6TB)`` — a capacity the code never
    measured. The last path component is all we actually know.
    """
    return os.path.basename(path.rstrip(os.sep)) or path


def disk_report(roots: list[str], *, probe: SystemProbe) -> dict:
    """``{"volumes": [...]}`` — one entry per configured root.

    The volumes are the deployment's own allowed roots, not a list written down
    when this page was built: those roots are already the authority for which
    folders this app may write to, so they are also the answer to "which
    storages exist". Every volume is checked for being its own filesystem first
    — reporting usage for a path that merely *sits* somewhere would be
    confident and wrong, which is worse than reporting nothing.
    """
    result = []
    for path in roots:
        entry = {"name": volume_name(path), "path": path}
        if is_foreign_filesystem(path, probe=probe):
            entry.update({
                "total_bytes": 0,
                "used_bytes": 0,
                "free_bytes": 0,
                "percent": 0,
                "error": "no es un punto de montaje (las cifras serían las de otro disco)",
            })
            result.append(entry)
            continue
        try:
            usage = probe.disk_usage(path)
        except (OSError, FileNotFoundError):
            entry.update({
                "total_bytes": 0,
                "used_bytes": 0,
                "free_bytes": 0,
                "percent": 0,
                "error": "no disponible",
            })
        else:
            entry.update({
                "total_bytes": usage.total,
                "used_bytes": usage.used,
                "free_bytes": usage.free,
                "percent": round(usage.used / usage.total * 100, 1) if usage.total > 0 else 0,
            })
        result.append(entry)
    return {"volumes": result}
