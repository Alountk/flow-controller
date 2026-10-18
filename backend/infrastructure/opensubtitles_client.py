"""Cliente HTTP de OpenSubtitles (S6/T6) — búsqueda y descarga de `.srt`.

La API de OpenSubtitles responde a dos preguntas que el mixer necesita tras la
extracción: qué subtítulos existen para unos idiomas (`search_subtitles`) y el
texto `.srt` de uno concreto (`download_subtitle`, llega como gzip).

Dos reglas duras:

- la API key viaja solo en las llamadas a `api.opensubtitles.com` — el `link`
  de descarga es un CDN de terceros y no la recibe, y los mensajes de error
  jamás la contienen;
- todo fallo (HTTP no-2xx, sin clave, sin enlace, JSON roto, gzip roto) sube
  como `OpenSubtitlesError` con mensaje corto, para que la ruta lo anote en el
  `detail` de la entrada y siga con el resto de idiomas.

Funciones síncronas: las rutas las sacan del event loop con
`asyncio.to_thread` (misma regla que `probe_file`). El transporte HTTP se
selecciona en `_client`; los tests lo sustituyen por un `httpx.MockTransport`
— aquí no hay red real nunca.
"""

import gzip

import httpx

import config
from application.ports import OpenSubtitlesError

API_BASE = "https://api.opensubtitles.com/api/v1"
USER_AGENT = "flow-controller/0.1.0"

__all__ = ["OpenSubtitlesError", "download_subtitle", "search_subtitles"]


def _headers(api_key: str) -> dict:
    return {
        "Api-Key": api_key,
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    }


def _client(timeout: float) -> httpx.Client:
    """Cliente HTTP de una llamada. Los tests lo reemplazan por un stub."""
    return httpx.Client(timeout=timeout)


def _check(api_key: str) -> None:
    if not api_key:
        raise OpenSubtitlesError("falta la API key de OpenSubtitles")


def _get_json(client: httpx.Client, url: str, headers: dict, params: dict | None = None) -> dict:
    try:
        resp = client.get(url, headers=headers, params=params)
    except httpx.HTTPError as exc:
        raise OpenSubtitlesError(f"sin respuesta ({type(exc).__name__})") from exc
    if resp.status_code // 100 != 2:
        raise OpenSubtitlesError(f"HTTP {resp.status_code}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise OpenSubtitlesError("respuesta no JSON") from exc
    if not isinstance(data, dict):
        raise OpenSubtitlesError("respuesta no válida")
    return data


def search_subtitles(api_key: str, query: str, languages: str, limit: int = 10) -> list[dict]:
    """Candidatos de subtítulo para `query` en `languages` (CSV ISO 639-2).

    La API devuelve items con varios `files`; esto devuelve UNA entrada por
    fichero — el plan de subtítulos decide por `file_id` — limitada a `limit`.
    """
    _check(api_key)
    with _client(config.REQUEST_TIMEOUT) as client:
        data = _get_json(
            client,
            f"{API_BASE}/subtitles",
            _headers(api_key),
            params={
                "query": query,
                "languages": languages,
                "order_by": "download_count",
                "order_direction": "desc",
            },
        )

    results: list[dict] = []
    for item in data.get("data") or []:
        attrs = item.get("attributes") or {}
        feature = attrs.get("feature_details") or {}
        for file in attrs.get("files") or []:
            results.append({
                "file_id": file.get("file_id"),
                "language": attrs.get("language", ""),
                "release": attrs.get("release", ""),
                "title": feature.get("title", ""),
                "file_name": file.get("file_name", ""),
            })
            if len(results) >= limit:
                return results
    return results


def download_subtitle(api_key: str, file_id: int) -> str:
    """Texto `.srt` del fichero `file_id`.

    `POST /download` da un `link` temporal; lo que llega de ahí es un gzip que
    se descomprime a UTF-8 con errors="replace" (un `.srt` con un byte raro
    sigue siendo legible).
    """
    _check(api_key)
    headers = _headers(api_key)
    headers["Content-Type"] = "application/json"
    with _client(config.REQUEST_TIMEOUT * 2) as client:
        try:
            resp = client.post(f"{API_BASE}/download", headers=headers, json={"file_id": file_id})
        except httpx.HTTPError as exc:
            raise OpenSubtitlesError(f"sin respuesta ({type(exc).__name__})") from exc
        if resp.status_code // 100 != 2:
            raise OpenSubtitlesError(f"HTTP {resp.status_code}")
        try:
            payload = resp.json()
        except ValueError as exc:
            raise OpenSubtitlesError("respuesta no JSON") from exc
        link = payload.get("link") if isinstance(payload, dict) else None
        if not link:
            raise OpenSubtitlesError("sin enlace de descarga")

        # Sin `Api-Key` aquí: el link apunta a un CDN de terceros.
        try:
            file_resp = client.get(link, headers={"User-Agent": USER_AGENT})
        except httpx.HTTPError as exc:
            raise OpenSubtitlesError(f"sin respuesta ({type(exc).__name__})") from exc
        if file_resp.status_code // 100 != 2:
            raise OpenSubtitlesError(f"HTTP {file_resp.status_code}")
        try:
            return gzip.decompress(file_resp.content).decode("utf-8", errors="replace")
        except OSError as exc:
            raise OpenSubtitlesError("la descarga no es un gzip") from exc
