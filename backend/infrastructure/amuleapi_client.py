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

import aiohttp

import config

log = logging.getLogger("flow-controller")

__all__ = ["AmuleAPIError", "AmuleAPIClient", "login"]

LOGIN_PATH = "/api/v1/auth/login?include_token=true"
_MASK = "****"
_BODY_MAX = 200


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

    async def request(self, session, method: str, path: str, **kwargs) -> dict | list:
        """Petición Bearer con login bajo demanda y la regla 401 de REFERENCE.md.

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
        return _decode(self.base_url, status, text, self.password, self.token)
