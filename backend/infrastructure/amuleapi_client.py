"""Cliente HTTP de `amuleapi` (REST oficial de aMule 3.x): login JWT y Bearer.

T3/S2: este módulo es el único que habla con la REST de aMule
(`docs/api/REFERENCE.md` de `amule-org/amule`, v1) en el camino activo:

- ``POST {base}/api/v1/auth/login?include_token=true`` con ``{"password": …}``
  → ``{"token": …}``: el token va en el cuerpo porque somos servidor a
  servidor (la cookie es para navegadores);
- llamadas autenticadas con ``Authorization: Bearer <token>``;
- **el primer 401 es terminal para el token** (REFERENCE.md: reintentarlo
  nunca funciona y cada token rechazado cuenta para un limitador que bloquea
  la IP 300 s): token a la basura, re-login y UN reintento de la petición;
  un segundo 401 —o un re-login fallido— sube como `AmuleAPIError`. El login
  **nunca** se reintenta (limitador propio: 5 fallos/60 s → 300 s de bloqueo).

T4a/S2 crece el módulo sin tocar llamadores: `search` (búsqueda ed2k con
sondeo acotado por el presupuesto del llamador), `free_search`,
`ensure_category` y `promote_result`. La regla 401 de arriba vale para TODAS
las llamadas.

Los errores suben SIEMPRE tipados (`AmuleAPIError` con status/error_kind/
detalle): ni traceback crudo, ni `TimeoutError: ` pelado — el detalle nombra
los segundos (espejo del `_empty_answer_detail` de `arr_client.py`). La
contraseña y el token jamás entran en mensajes, `repr` ni logs.

La sesión `aiohttp` la pasa el llamador (una por petición HTTP) y también
`base_url`/`password` (T4 pasa `config.AMULEAPI_URL`/`config.AMULEAPI_PASSWORD`
— aquí no se lee nada global salvo `config.REQUEST_TIMEOUT` para los timeouts).
"""

import asyncio
import json
import logging
import time

import aiohttp

import config

log = logging.getLogger("flow-controller")

__all__ = [
    "AmuleAPIError", "AmuleAPIClient", "login",
    "search", "free_search", "ensure_category", "promote_result",
]

LOGIN_PATH = "/api/v1/auth/login?include_token=true"
_MASK = "****"
_BODY_MAX = 200
# Un listado trae sólo 100 ítems por página (REFERENCE.md): aquí se pide todo.
_WHOLE_PAGE = "?limit=1000000000"


def _redact(text: str, *secrets: str) -> str:
    """El texto sin secretos: mismo contrato que `_redact` de `qbit_client`."""
    for secret in secrets:
        if secret:
            text = text.replace(secret, _MASK)
    return text


def _empty_answer_detail(exc: BaseException, timeout: aiohttp.ClientTimeout) -> str:
    """`str(TimeoutError())` es vacío: el presupuesto es el detalle.

    Espejo del `_empty_answer_detail` de `arr_client.py`/`qbit_client.py` — un
    `f"{type}: {exc}"` pelado dejaba un `TimeoutError: ` colgando sin decir nada.
    """
    if str(exc):
        return f"{type(exc).__name__}: {exc}"
    return f"{type(exc).__name__}: sin respuesta tras {int(timeout.total)}s"


class AmuleAPIError(Exception):
    """Fallo tipado de `amuleapi`: status HTTP (o None si no hubo respuesta),
    `error_kind` en la taxonomía de `arr_failure` ("auth"/"http"/"timeout"/
    "unreachable") y `detalle` honesto en español, ya sin secretos."""

    def __init__(self, status: int | None, error_kind: str, detail: str):
        self.status = status
        self.error_kind = error_kind
        self.detail = detail
        super().__init__(detail)

    def __repr__(self) -> str:
        # Carga los tres atributos (vulture) y sólo valores ya redactados.
        return (
            f"AmuleAPIError(status={self.status!r}, error_kind={self.error_kind!r}, "
            f"detail={self.detail!r})"
        )


def _retry_after(headers) -> str:
    """Los segundos del `Retry-After` de un 429; CIMultiDict o dict simple."""
    for key, value in headers.items():
        if key.lower() == "retry-after":
            return str(value)
    return ""


def _envelope_detail(text: str) -> str:
    """El `message` del sobre `{"error": {code, message}}` de REFERENCE.md.

    Sin sobre (o sin JSON) se cita el cuerpo tal cual, truncado después:
    honesto, nunca inventado.
    """
    try:
        data = json.loads(text)
    except ValueError:
        return text.strip()
    if isinstance(data, dict) and isinstance(data.get("error"), dict):
        err = data["error"]
        return str(err.get("message") or err.get("code") or text.strip())
    return text.strip()


def _http_error(base: str, status: int, text: str, headers, *secrets: str) -> AmuleAPIError:
    body = _redact(_envelope_detail(text), *secrets)[:_BODY_MAX] or "sin detalle"
    if status == 429:
        retry = _retry_after(headers)
        if retry:
            body = f"{body} — reintentar en {retry} s"
    kind = "auth" if status in (401, 403) else "http"
    return AmuleAPIError(status, kind, f"amuleapi ({base}) respondió HTTP {status}: {body}")


def _transport_error(
    base: str, kind: str, exc: BaseException, timeout: aiohttp.ClientTimeout, *secrets: str
) -> AmuleAPIError:
    detail = _redact(_empty_answer_detail(exc, timeout), *secrets)
    return AmuleAPIError(None, kind, f"amuleapi ({base}): {detail}")


def _decode(base: str, status: int, text: str, *secrets: str) -> dict | list:
    """JSON obligatorio (objeto o lista): lo que no lo es sube tipado."""
    try:
        data = json.loads(text)
    except ValueError:
        body = _redact(text.strip(), *secrets)[:_BODY_MAX]
        raise AmuleAPIError(
            status, "http", f"amuleapi ({base}) respondió HTTP {status} sin JSON válido: {body}"
        ) from None
    if not isinstance(data, (dict, list)):
        raise AmuleAPIError(
            status, "http", f"amuleapi ({base}) respondió un JSON que no es objeto ni lista"
        )
    return data


def _ed2k_link(row: dict) -> str:
    """El enlace ed2k compuesto: la REST da hash/nombre/tamaño, no el enlace."""
    return f"ed2k://|file|{row.get('name', '')}|{row.get('size_bytes', 0)}|{row.get('hash', '')}|/"


def _find_category(rows: list[dict], name: str) -> dict | None:
    for row in rows:
        if row.get("name") == name:
            return row
    return None


async def login(session, base_url: str, password: str) -> str:
    """POST /api/v1/auth/login?include_token=true → el token.

    Nunca se reintenta: el limitador del login son 5 fallos/60 s → 300 s de
    bloqueo por IP, así que un fallo (401/403 incluido) sube en el primer
    intento. Sólo debe llamarse sin token o con el recién rechazado.
    """
    base = (base_url or "").rstrip("/")
    timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT)
    try:
        async with session.post(
            base + LOGIN_PATH,
            json={"password": password},
            headers={"Content-Type": "application/json"},
            timeout=timeout,
        ) as resp:
            status, text, headers = resp.status, await resp.text(), resp.headers
    except asyncio.TimeoutError as exc:
        raise _transport_error(base, "timeout", exc, timeout, password) from None
    except aiohttp.ClientError as exc:
        raise _transport_error(base, "unreachable", exc, timeout, password) from None
    if not 200 <= status < 300:
        raise _http_error(base, status, text, headers, password)
    data = _decode(base, status, text, password)
    token = data.get("token") if isinstance(data, dict) else None
    if not token:
        raise AmuleAPIError(status, "http", f"amuleapi ({base}) no devolvió token en el login")
    return str(token)


class AmuleAPIClient:
    """Cliente con token cacheado: login bajo demanda y la regla 401 exacta."""

    def __init__(self, base_url: str, password: str):
        self.base_url = (base_url or "").rstrip("/")
        self.password = password
        self.token = ""

    def __repr__(self) -> str:
        # Sólo la URL: la contraseña y el token jamás en un repr.
        return f"AmuleAPIClient(base_url={self.base_url!r})"

    async def _exchange(self, session, method: str, path: str, **kwargs):
        """(status, texto, cabeceras) o error tipado de transporte."""
        timeout = aiohttp.ClientTimeout(total=config.REQUEST_TIMEOUT)
        kwargs.pop("timeout", None)  # el presupuesto manda: config.REQUEST_TIMEOUT
        headers = dict(kwargs.pop("headers", None) or {})
        headers["Authorization"] = f"Bearer {self.token}"
        try:
            async with session.request(
                method, self.base_url + path, headers=headers, timeout=timeout, **kwargs
            ) as resp:
                return resp.status, await resp.text(), resp.headers
        except asyncio.TimeoutError as exc:
            raise _transport_error(
                self.base_url, "timeout", exc, timeout, self.password, self.token
            ) from None
        except aiohttp.ClientError as exc:
            raise _transport_error(
                self.base_url, "unreachable", exc, timeout, self.password, self.token
            ) from None

    async def _signed(self, session, method: str, path: str, **kwargs) -> tuple[int, str, dict]:
        """(status, texto, cabeceras) con la regla 401 ya aplicada, sin decodificar.

        401 → token a la basura, re-login y UN reintento; segundo 401 o
        re-login fallido → `AmuleAPIError`. Nunca hay bucle ni reintento ciego.
        """
        if not self.token:
            self.token = await login(session, self.base_url, self.password)
        status, text, headers = await self._exchange(session, method, path, **kwargs)
        if status == 401:
            self.token = ""
            log.info("amuleapi 401 terminal para el token, re-login base=%s", self.base_url)
            self.token = await login(session, self.base_url, self.password)
            status, text, headers = await self._exchange(session, method, path, **kwargs)
            if status == 401:
                rejected = self.token
                self.token = ""
                raise _http_error(
                    self.base_url, status, text, headers, self.password, rejected
                )
        if not 200 <= status < 300:
            raise _http_error(self.base_url, status, text, headers, self.password, self.token)
        return status, text, headers

    async def request(self, session, method: str, path: str, **kwargs) -> dict | list:
        """Petición Bearer con la regla 401 de REFERENCE.md (ver `_signed`)."""
        status, text, _ = await self._signed(session, method, path, **kwargs)
        return _decode(self.base_url, status, text, self.password, self.token)

    async def _send_no_body(self, session, method: str, path: str, **kwargs) -> None:
        """Mutación 204/202 sin cuerpo: la regla 401 vale igual y no hay JSON que decodificar."""
        await self._signed(session, method, path, **kwargs)


async def search(
    client, session, query: str, *, deadline_seconds: float, search_type: str = "global",
    file_type: str | None = None, extension: str | None = None,
    min_size_bytes: int | None = None, max_size_bytes: int | None = None,
    min_source_count: int | None = None,
    min_bitrate_kilobits_per_second: int | None = None,
    min_duration_seconds: int | None = None, codec: str | None = None,
    title: str | None = None, album: str | None = None, artist: str | None = None,
    poll_interval: float = 1.0,
) -> dict:
    """Búsqueda ed2k completa (T4a/S2): arranque, sondeo acotado y resultados.

    `POST /api/v1/search` y luego `GET …/results?limit=…` mientras
    `progress.state == "running"` (REFERENCE.md: el endpoint no espera, el
    cliente sondea; ~1 s entre sondeos basta por su caché de refresco).
    `deadline_seconds` es presupuesto del llamador: agotado, se detiene con
    `POST …/stop` en mejor esfuerzo —el stop CONSERVA los resultados, el
    delete los libera— y sube `AmuleAPIError` "timeout" nombrando los
    segundos. Nunca se sondea sin límite.

    Devuelve `{"search_id", "results"}`: los ítems tal como los trae la
    REST (sin filtrar ni ordenar) más `ed2k_link`, que la REST no devuelve
    y se compone de nombre/tamaño/hash. El `search_id` sigue vivo para
    `promote_result` (exige una búsqueda abierta) y `free_search`.
    """
    body = {"query": query, "type": search_type}
    for key, value in (
        ("file_type", file_type), ("extension", extension),
        ("min_size_bytes", min_size_bytes), ("max_size_bytes", max_size_bytes),
        ("min_source_count", min_source_count),
        ("min_bitrate_kilobits_per_second", min_bitrate_kilobits_per_second),
        ("min_duration_seconds", min_duration_seconds), ("codec", codec),
        ("title", title), ("album", album), ("artist", artist),
    ):
        if value is not None:
            body[key] = value
    created = await client.request(session, "POST", "/api/v1/search", json=body)
    search_id = created.get("search_id") if isinstance(created, dict) else None
    if search_id is None:
        raise AmuleAPIError(
            None, "http",
            f"amuleapi ({client.base_url}) no devolvió «search_id» al arrancar la búsqueda",
        )
    deadline = time.monotonic() + deadline_seconds
    while True:
        page = await client.request(
            session, "GET", f"/api/v1/search/{search_id}/results{_WHOLE_PAGE}"
        )
        items, state = _search_page(client.base_url, search_id, page)
        if state != "running":
            return {"search_id": search_id, "results": items}
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            # Elegido stop (no delete): pausa la búsqueda conservando los
            # resultados parciales; `free_search` es la limpieza del llamador.
            await _stop_best_effort(client, session, search_id)
            raise AmuleAPIError(
                None, "timeout",
                f"amuleapi ({client.base_url}): la búsqueda {search_id} no terminó en {deadline_seconds} s",
            )
        await asyncio.sleep(min(poll_interval, remaining))


def _search_page(base: str, search_id, page) -> tuple[list[dict], str]:
    """(ítems, estado) validando la forma «results»/«progress» de REFERENCE.md."""
    results = page.get("results") if isinstance(page, dict) else None
    progress = page.get("progress") if isinstance(page, dict) else None
    state = progress.get("state") if isinstance(progress, dict) else None
    if (
        not isinstance(results, list)
        or not all(isinstance(row, dict) for row in results)
        or not isinstance(state, str)
    ):
        raise AmuleAPIError(
            None, "http",
            f"amuleapi ({base}) devolvió la búsqueda {search_id} sin la forma "
            "«results»/«progress» de REFERENCE.md",
        )
    return [{**row, "ed2k_link": _ed2k_link(row)} for row in results], state


async def _stop_best_effort(client, session, search_id) -> None:
    """Mejor esfuerzo: un stop fallido no debe tapar jamás el timeout que sube."""
    try:
        await client._send_no_body(session, "POST", f"/api/v1/search/{search_id}/stop")
    except AmuleAPIError as exc:
        log.warning("amuleapi: no se pudo detener la búsqueda %s: %s", search_id, exc.detail)


async def free_search(client, session, search_id) -> None:
    """`DELETE /api/v1/search/{id}`: detiene Y libera (el consumidor ya terminó)."""
    await client._send_no_body(session, "DELETE", f"/api/v1/search/{search_id}")


async def ensure_category(
    client, session, name: str, *, save_path: str | None = None, comment: str | None = None,
    color: str | None = None, priority: str | None = None,
) -> dict:
    """La categoría `name`: la existente por nombre exacto, o creada UNA vez si falta.

    La REST no tiene 409 de duplicado para `POST /categories` (devuelve 202
    sin índice): se lista primero, se crea como mucho una vez y el índice
    se toma del re-listado posterior, tal como manda REFERENCE.md.
    """
    row = _find_category(await _categories(client, session), name)
    if row is not None:
        return row
    body = {"name": name}
    for key, value in (
        ("save_path", save_path), ("comment", comment),
        ("color", color), ("priority", priority),
    ):
        if value is not None:
            body[key] = value
    await client._send_no_body(session, "POST", "/api/v1/categories", json=body)
    row = _find_category(await _categories(client, session), name)
    if row is None:
        raise AmuleAPIError(
            None, "http",
            f"amuleapi ({client.base_url}) creó la categoría «{name}» pero no aparece en el listado",
        )
    return row


async def _categories(client, session) -> list[dict]:
    data = await client.request(session, "GET", f"/api/v1/categories{_WHOLE_PAGE}")
    rows = data.get("categories") if isinstance(data, dict) else None
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise AmuleAPIError(
            None, "http",
            f"amuleapi ({client.base_url}) devolvió categorías sin la forma «categories» de REFERENCE.md",
        )
    return rows


async def promote_result(
    client, session, result_hash: str, *, category_index: int | None = None,
    ecid: int | None = None,
) -> None:
    """`POST /api/v1/search/results/{hash}/download`: el resultado pasa a la cola.

    `category_index` (categoría de la descarga) y `ecid` (nombre alternativo
    del grupo) son opcionales en REFERENCE.md; sin ellos el cuerpo es `{}`.
    """
    body = {}
    if category_index is not None:
        body["category_index"] = category_index
    if ecid is not None:
        body["ecid"] = ecid
    await client._send_no_body(
        session, "POST", f"/api/v1/search/results/{result_hash}/download", json=body
    )
