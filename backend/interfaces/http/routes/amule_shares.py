"""aMule's shared folders, read and written where aMule keeps them.

aMule stores this configuration itself, in three plain-text files inside its
own config directory — one path per line:

    shareddir-recursive.dat   roots walked in full
    shareddir-explicit.dat    roots shared one level deep
    shareddir.dat             the union aMule regenerates for older tools

Writing the first two and asking aMule to reload is the supported route, not
a workaround: `CPreferences::ReloadSharedFolders` reconciles files an external
process changed — its own comment names "Docker entrypoints, manual sysadmin
edits" — and keeps the diff through its own regeneration. So these files stay
the single source of truth and this endpoint never becomes a second one; it
reads them and rewrites them.

Two constraints shape the code below:

* **The write is in place.** The config directory belongs to aMule and is
  `drwxr-xr-x`, so a write-to-temp-then-rename would need directory permission
  this app does not have. Rewriting in place is safe only because a reload
  follows immediately and aMule reads these files *on reload* — a partial
  write is never observed.
* **Only paths inside `allowed_roots` may be shared.** Making aMule publish a
  folder is not reversible from here, and `allowed_roots` is the same
  authority that already decides which folders this app may touch. Sharing
  outside it would hand the API key a way to expose, for instance, the config
  directory that holds the credentials themselves.
"""

import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from application.gateways import amutorrent_reload_shared_dirs, get_setting
from config import ALLOWED_ROOTS
from interfaces.http.routes.status import verify_api_key
from state import http_session

router = APIRouter()
log = logging.getLogger("flow-controller")

#: aMule's config directory. Deployment-specific — it is a separate mount
#: from the download folders, so nothing derives it — and read like `path_4k`
#: rather than cached on `config`, because a settings file written before this
#: feature simply does not have the key.
DEFAULT_AMULE_CONFIG_DIR = "/mnt/storage/amule/config"


def _config_dir() -> Path:
    return Path(str(get_setting("paths", "amule_config", default=DEFAULT_AMULE_CONFIG_DIR) or ""))


def _list_files() -> tuple[Path, Path]:
    base = _config_dir()
    return base / "shareddir-recursive.dat", base / "shareddir-explicit.dat"


def _read(path: Path) -> list[str]:
    """The configured roots, in file order.

    A missing file means "nothing configured", not an error: a fresh aMule
    has all three at 0 bytes or absent entirely.
    """
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    return [line.strip() for line in text.splitlines() if line.strip()]


def _validate(raw: object) -> list[str]:
    """Absolute paths inside the allowed roots, de-duplicated, order kept."""
    if not isinstance(raw, list):
        raise HTTPException(422, "se espera una lista de rutas")

    checked: list[str] = []
    for item in raw:
        if not isinstance(item, str) or not item.startswith("/"):
            raise HTTPException(422, f"la ruta debe ser absoluta: {item!r}")
        root = item.rstrip("/")
        inside = any(root == r.rstrip("/") or root.startswith(r.rstrip("/") + "/") for r in ALLOWED_ROOTS)
        if not inside:
            raise HTTPException(
                403,
                f"fuera de las raíces permitidas: {item} — comparte solo carpetas "
                f"que ya estén en `allowed_roots`",
            )
        if root not in checked:
            checked.append(root)
    return checked


@router.get("/api/amule/shared-dirs")
async def get_shared_dirs(_key: str = Depends(verify_api_key)):
    """Lo que aMule comparte hoy, tal y como lo tiene escrito."""
    recursive, explicit = _list_files()
    return {
        "config_dir": str(_config_dir()),
        "recursive": _read(recursive),
        "explicit": _read(explicit),
        "allowed_roots": list(ALLOWED_ROOTS),
    }


@router.put("/api/amule/shared-dirs")
async def put_shared_dirs(body: dict, _key: str = Depends(verify_api_key)):
    """Reescribe la configuración de compartidos de aMule y le pide que recargue.

    Validación antes de escribir: un rechazo no deja nada a medias. Si luego
    la recarga falla, los ficheros ya están escritos — el cambio queda
    *pendiente* y la respuesta lo dice, para que la UI no lo pinte como hecho.
    """
    recursive = _validate(body.get("recursive", []))
    explicit = _validate(body.get("explicit", []))

    base = _config_dir()
    if not base.is_dir():
        raise HTTPException(
            503,
            f"no existe la carpeta de configuración de aMule: {base} — "
            "revísala en Rutas → Carpeta de configuración de aMule",
        )

    r_file, e_file = _list_files()
    try:
        # In place, never temp-then-rename: see the module docstring.
        r_file.write_text("".join(f"{p}\n" for p in recursive), encoding="utf-8")
        e_file.write_text("".join(f"{p}\n" for p in explicit), encoding="utf-8")
    except OSError as exc:
        raise HTTPException(500, f"no se pudo escribir en {base}: {exc}") from exc

    async with http_session() as session:
        reload_result = await amutorrent_reload_shared_dirs(session)

    log.info(
        "shared-dirs guardadas: %d recursivas, %d explícitas (recarga: %s)",
        len(recursive), len(explicit), reload_result.get("ok"),
    )
    return {
        "ok": bool(reload_result.get("ok")),
        "recursive": recursive,
        "explicit": explicit,
        "reload": reload_result,
    }
