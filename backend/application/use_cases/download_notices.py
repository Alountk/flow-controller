"""Qué se avisa y qué se calla (C-01, S3/S4/S5/S6), sin una sola lectura.

La mitad interesante de los avisos es la REGLA — «esta terminó», «esta quedó
importada» — y una regla que solo se puede observar a través de un socket no se
puede fijar. Por eso este módulo decide y no envía: recibe el estado ya leído
(filas del historial, snapshots, carpeta) y devuelve la lista de avisos que
toca. El envío y sus reintentos viven en `download_notices_emit`.

La memoria de lo enviado entra como `state` (`{(clave, aviso): (ok, intentos)}`)
para que el reintento acotado de S6 sea una decisión, no un efecto.
"""

from __future__ import annotations

import logging
import os

from application.use_cases import notifier

log = logging.getLogger(__name__)

NOTICE_A = "a"
NOTICE_B = "b"

#: Un canal mal configurado no puede martillear cada 3 s para siempre, y callar
#: sin rastro sería mentir. Tres intentos y se da por perdido, con la fila ahí.
MAX_ATTEMPTS = 3

#: `trackedDownloadState` que significan «el archivo ya está en su sitio».
IMPORTED_STATE = "imported"

State = dict[tuple[str, str], tuple[int, int]]


def _wanted(state: State, key: str, notice: str) -> bool:
    """Is this one worth an attempt? Sent, or out of attempts, means no."""
    sent, attempts = state.get((key, notice), (0, 0))
    return not sent and attempts < MAX_ATTEMPTS


def download_key(download: dict) -> str:
    """Stable across ticks and across a restart: the arr keeps `id` while it queues."""
    return f"{download.get('source', '')}:{download.get('id', '')}"


def _is_finished(download: dict) -> bool:
    progress = download.get("progress") or 0
    sizeleft = download.get("sizeleft")
    return progress >= 100 or (isinstance(sizeleft, (int, float)) and sizeleft <= 0)


def plan_for_downloads(downloads: list[dict], state: State) -> list[dict]:
    """Aviso A cuando el cliente terminó, B cuando el archivo quedó importado."""
    planned: list[dict] = []
    for download in downloads:
        key = download_key(download)
        title = download.get("title") or "Descarga"
        # El mismo elemento puede llevar A y B: son dos momentos distintos (S5).
        if download.get("tracked_state") == IMPORTED_STATE:
            if _wanted(state, key, NOTICE_B):
                planned.append({
                    "key": key,
                    "notice": NOTICE_B,
                    "title": "Importado",
                    "message": f"{title} ya está en la biblioteca.",
                    "tags": ["inbox_tray"],
                })
        elif _is_finished(download) and _wanted(state, key, NOTICE_A):
            planned.append({
                "key": key,
                "notice": NOTICE_A,
                "title": "Descarga terminada",
                "message": f"{title} ya bajó. Falta el import.",
                "tags": ["arrow_down"],
            })
    return planned


def plan_for_folder(previous: dict[str, int] | None, current: dict[str, int], state: State) -> list[dict]:
    """aMule no expone progreso (L3): un archivo terminado es una talla que dejó de crecer.

    La primera vez que se ve un archivo solo se registra. Tras un reinicio no hay
    tick anterior y decir «terminó» de algo que quizá lleva horas bajando es peor
    que callar un tick.
    """
    if not previous:
        return []
    planned: list[dict] = []
    for path, size in current.items():
        if previous.get(path) != size:
            continue
        key = f"amule:{path}:{size}"
        if not _wanted(state, key, NOTICE_A):
            continue
        planned.append({
            "key": key,
            "notice": NOTICE_A,
            "title": "Descarga terminada",
            "message": f"{path.rsplit('/', 1)[-1]} ya bajó. Falta el import.",
            "tags": ["arrow_down"],
        })
    return planned


# --- La mitad que envía: historial, canal y reintentos ----------------------
#
# Nada de esto puede escapar hacia el poller: un canal caído no puede congelar
# el snapshot (S7), así que todo se envuelve y lo único que sube es la lista de
# lo intentado.


def _store():
    """El historial durable, o None si la composición no lo ha enlazado."""
    try:
        from application import gateways  # noqa: PLC0415 — enlazado en el arranque
    except Exception:  # noqa: BLE001 — sin registro de puertos no hay memoria
        return None
    return getattr(gateways, "history", None)


def scan_folder(directory: str) -> dict[str, int]:
    """`{ruta: talla}` de los ficheros de una carpeta. Vacío si no se puede leer."""
    if not directory:
        return {}
    found: dict[str, int] = {}
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                try:
                    if entry.is_file():
                        found[entry.path] = entry.stat().st_size
                except OSError:
                    continue
    except OSError:
        return {}
    return found


def _states(planned: list[dict]) -> State:
    store = _store()
    if store is None:
        return {}
    try:
        return store.notice_states([(p["key"], p["notice"]) for p in planned])
    except Exception:  # noqa: BLE001 — sin memoria se avisa de más, nunca de menos
        return {}


async def _send(planned: list[dict]) -> list[dict]:
    """Envía lo planeado y registra cada intento, con o sin éxito."""
    if not planned:
        return []
    channel = notifier.config()
    if not (channel["enabled"] and channel["url"] and channel["topic"]):
        return []
    store = _store()
    sent: list[dict] = []
    for notice in planned:
        result = await notifier.send(
            notice["title"], notice["message"],
            tags=notice.get("tags"), priority=None,
        )
        if store is not None:
            try:
                store.record_notice_attempt(notice["key"], notice["notice"], ok=bool(result["ok"]))
            except Exception:  # noqa: BLE001 — perder la memoria no puede perder el aviso
                pass
        if result["ok"]:
            sent.append(notice)
        else:
            log.warning("Aviso no enviado (%s %s): %s", notice["key"], notice["notice"], result["error"])
    return sent


async def announce_downloads(snapshot: dict) -> list[dict]:
    """Aviso A o B de cada descarga del snapshot que lo merezca (S3/S4)."""
    downloads = snapshot.get("downloads") or []
    planned = plan_for_downloads(downloads, _states_for_downloads(downloads))
    return await _send(planned)


def _states_for_downloads(downloads: list[dict]) -> State:
    return _states(
        [{"key": download_key(d), "notice": notice}
         for d in downloads for notice in (NOTICE_A, NOTICE_B)]
    )


async def announce_folder(folder: dict[str, int]) -> list[dict]:
    """Aviso A de aMule: la talla dejó de crecer (L3, S3)."""
    global _folder_previous
    planned = plan_for_folder(_folder_previous, folder, _states(
        [{"key": f"amule:{path}:{size}", "notice": NOTICE_A} for path, size in folder.items()]
    ))
    _folder_previous = folder
    return await _send(planned)


#: El tick anterior de la carpeta de aMule. En memoria a propósito: tras un
#: reinicio no hay tick anterior y esa ausencia ES la respuesta («no sé si
#: estaba creciendo»).
_folder_previous: dict[str, int] | None = None
