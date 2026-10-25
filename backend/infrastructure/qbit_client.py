"""Cliente qBittorrent NATIVO — login+SID y un add, sin fachadas ni deps.

S1: «no quiero tener el amutorrent como bypass… no quiero dependencias,
excepto las estrictas» — este módulo sólo usa aiohttp. Habla la web API de
qBittorrent como la habla qBittorrent mismo (D2, verificado en vivo, Log L3):

- ``POST /api/v2/auth/login`` (form username/password/rememberMe, header
  ``Referer``) → cookie SID. Bearer devuelve **403** en el build real, así que
  la sesión autenticada por login es ÚNICA vía;
- ``POST /api/v2/torrents/add`` (form ``urls``+``category``, headers
  ``Referer``/``Origin``) en la MISMA sesión — la cookie SID es la auth;
- SIN paso de categoría (D4): ``createCategories`` responde 404 en este build
  y el ``add`` auto-crea `flow`. Un `ensure_category` rompería cada add con
  una falsa alarma.

S5 es la razón de este módulo: el puente antiguo miraba sólo el status y la
fachada devolvía **200+`Fail.`** a todo add → éxito inventado. Aquí el éxito
es HTTP **200** Y body `strip()` ∈ {"", "Ok."} — todo lo demás es un rechazo
honesto con el body (roto a ≤200, redactando `apikey=`). Y S2 manda que el
detalle nombre el destino EN AMBAS direcciones («Descarga añadida en
qBittorrent (URL), categoría flow» / «qBittorrent (URL) no aceptó la
descarga: …»).

La configuración se lee de los globales de `config` (`QBIT_URL`,
`QBIT_USER`, `QBIT_PASSWORD`, settings-only sin default — D6) en el momento
de cada llamada: sin url/user/password no hay servicio y se responde la pista
de S3 sin un solo POST.
"""

import asyncio
import logging
import re

import aiohttp

import config

log = logging.getLogger("flow-controller")

#: Categoría de las descargas que esta app añade DIRECTAMENTE al cliente,
#: fuera de cualquier arr (el mismo contrato que `arr_client.DIRECT_DOWNLOAD_
#: CATEGORY` — la copia es a propósito: S1/S4 quieren este módulo autocontenido).
DIRECT_DOWNLOAD_CATEGORY = "flow"

_UNCONFIGURED = "qBittorrent no está configurado — añádelo en Configuración → Servicios"
_MASK = "****"

#: El add dispara el trabajo del cliente y la red ED2K medida tarda ~30 s
#: (presupuesto del precedente PR #193): ×12, nunca ×2.
_TIMEOUT_BUDGET = 12


def _redact(text: str, extra: str = "") -> str:
    """El texto sin secretos: `extra` (la contraseña usada), la contraseña
    configurada, el VALOR literal de cualquier `apikey=…` y la forma
    `apikey=…` misma.

    Misma regla que `_redact` de `routes/indexers.py` (que además borra la
    clave literal): una URL directa de .torrent arrastra `apikey=` en query y
    una excepción que la ecoa —o el eco del valor entre paréntesis— no debe
    filtrarla a la respuesta.
    """
    for secret in (extra, config.QBIT_PASSWORD):
        if secret:
            text = text.replace(secret, _MASK)
    for value in re.findall(r"(?i)apikey=([^&\s]+)", text):
        text = text.replace(value, _MASK)
    return re.sub(r"(?i)(apikey=)[^&\s]*", r"\g<1>" + _MASK, text)


def _empty_answer_detail(exc: BaseException, timeout: aiohttp.ClientTimeout) -> str:
    """`str(TimeoutError())` es vacío: el presupuesto es el detalle.

    Espejo del `_empty_answer_detail` de `arr_client.py` — un
    `f"{type}: {exc}"` pelado dejaba un `TimeoutError: ` colgando que no dice
    nada. Texto de usuario en español, como el resto del módulo.
    """
    if str(exc):
        return f"{type(exc).__name__}: {exc}"
    return f"{type(exc).__name__}: sin respuesta tras {int(timeout.total)}s"


def _refused(base: str, detail: str) -> dict:
    """El rechazo de S2, con el destino dentro y el body nunca entero."""
    body = _redact(detail)[:200]
    return {"ok": False, "detail": f"qBittorrent ({base}) no aceptó la descarga: {body}"}


async def _post(session: aiohttp.ClientSession, url: str, timeout: aiohttp.ClientTimeout, **kwargs):
    async with session.post(url, timeout=timeout, **kwargs) as resp:
        return resp.status, await resp.text()


async def qbit_add_download(
    session: aiohttp.ClientSession, url: str, category: str = DIRECT_DOWNLOAD_CATEGORY
) -> dict:
    """Login + add en `session`, con el contrato honesto de S5.

    `session` es la del llamador (una por petición HTTP): la cookie SID que el
    login fija es lo que autentica el add, y las dos llamadas tienen que
    verla. Devuelve `{ok, detail}` (+ `category` en éxito) — nunca lanza.
    """
    base, user, password = config.QBIT_URL, config.QBIT_USER, config.QBIT_PASSWORD
    if not (base and user and password):
        return {"ok": False, "detail": _UNCONFIGURED}

    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT * _TIMEOUT_BUDGET)
    log.info("qbit_add_download category=%s link=%s", category, url[:48])
    try:
        status, text = await _post(
            session,
            f"{base}/api/v2/auth/login",
            timeout,
            data={"username": user, "password": password, "rememberMe": "true"},
            headers={"Referer": base},
        )
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return _refused(base, _empty_answer_detail(exc, timeout))
    body = text.strip()
    if status != 200 or body != "Ok.":
        if status == 200 and body == "Fails.":
            return {"ok": False, "detail": f"qBittorrent rechazó las credenciales ({base})"}
        return _refused(base, f"HTTP {status}: {text}")

    try:
        status, text = await _post(
            session,
            f"{base}/api/v2/torrents/add",
            timeout,
            data={"urls": url, "category": category},
            headers={"Referer": base, "Origin": base},
        )
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return _refused(base, _empty_answer_detail(exc, timeout))
    body = text.strip()
    if status == 200 and body in ("", "Ok."):
        return {
            "ok": True,
            "detail": f"Descarga añadida en qBittorrent ({base}), categoría {category}",
            "category": category,
        }
    if status != 200:
        return _refused(base, f"HTTP {status}: {text}")
    return _refused(base, text)


async def qbit_login_probe(
    session: aiohttp.ClientSession, url: str, user: str, password: str
) -> dict:
    """Login y nada más: la sonda de estado y de `POST /api/services/test`.

    `{ok, detail, error_kind}` — `error_kind` comparte la clasificación de
    `arr_failure` ("auth"/"http"/"timeout"/"unreachable") para que la fila de
    estado lea igual que la de los demás servicios. SIN versión ni meta: en el
    build real el login ES la prueba (D2: Bearer → 403).
    """
    if not (url and user and password):
        return {"ok": False, "detail": _UNCONFIGURED, "error_kind": "auth"}
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT)
    try:
        status, text = await _post(
            session,
            f"{url}/api/v2/auth/login",
            timeout,
            data={"username": user, "password": password, "rememberMe": "true"},
            headers={"Referer": url},
        )
    except asyncio.TimeoutError as exc:
        return {"ok": False, "detail": _empty_answer_detail(exc, timeout), "error_kind": "timeout"}
    except aiohttp.ClientError as exc:
        return {
            "ok": False,
            "detail": _empty_answer_detail(exc, timeout),
            "error_kind": "unreachable",
        }
    body = text.strip()
    if status == 200 and body == "Ok.":
        return {"ok": True, "detail": f"Conectado ({url})"}
    if status == 200 and body == "Fails.":
        return {"ok": False, "detail": "Credenciales rechazadas", "error_kind": "auth"}
    return {
        "ok": False,
        "detail": _redact(f"HTTP {status}: {text}", password)[:200],
        "error_kind": "http",
    }
