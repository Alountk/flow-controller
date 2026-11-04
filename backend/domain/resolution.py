"""¿Qué resolución es esta? Una sola respuesta para todo el backend.

Hay dos fuentes de verdad y no valen lo mismo: **lo que se midió** (ffprobe, el
`MediaInfo` de Radarr) y **lo que alguien escribió en el nombre**. Un fichero
llamado `720p` que mide 1920×800 es 1080 — las bandas negras se recortan y el
nombre se queda con la resolución del transfer original. Por eso `best()` prefiere
siempre la medida, y el nombre sólo decide cuando no hay medida.

Los umbrales son los de Radarr (`AugmentQualityFromMediaInfo`): **ancho O alto**,
porque mirar sólo el alto llamaba 1080 a todo el 4K panorámico (3840×1606) y
mirar sólo el ancho perdía los transfers con barras laterales.
"""

from __future__ import annotations

import re

#: Declarado en el nombre. El nombre no distingue 576 de 480: los dos son «SD».
_NAME_TOKENS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("2160", re.compile(r"\b(2160p|4k)\b", re.IGNORECASE)),
    ("1080", re.compile(r"\b1080[pi]\b", re.IGNORECASE)),
    ("720", re.compile(r"\b720p\b", re.IGNORECASE)),
    ("576", re.compile(r"\b576[pi]\b", re.IGNORECASE)),
    ("480", re.compile(r"\b(480[pi]|360p)\b|\bdvd", re.IGNORECASE)),
)


def from_dimensions(width: int, height: int) -> str:
    """La clase que demuestra el frame, o `""` si no hay medidas.

    Un lado a cero se ignora: ffprobe a veces reporta sólo uno, y un 0 nunca
    debe arrastrar el resultado hacia abajo.
    """
    width = max(int(width or 0), 0)
    height = max(int(height or 0), 0)
    if width == 0 and height == 0:
        return ""
    if width >= 3200 or height >= 2100:
        return "2160"
    if width >= 1800 or height >= 1000:
        return "1080"
    if width >= 1200 or height >= 700:
        return "720"
    if width >= 1000 or height >= 560:
        return "576"
    return "480"


def parse_dimensions(text: str) -> tuple[int, int]:
    """`"1920x800"` -> `(1920, 800)`; lo ilegible -> `(0, 0)`.

    Es el formato en que Radarr publica el frame medido y el único que emite, así
    que un valor que no parsea no prueba nada y no se adivina.
    """
    parts = str(text or "").lower().split("x")
    if len(parts) != 2:
        return (0, 0)
    try:
        return (int(parts[0]), int(parts[1]))
    except ValueError:
        return (0, 0)


def from_name(text: str) -> str:
    """La clase que declara un nombre, o `""` si no declara ninguna."""
    name = str(text or "")
    for measured, token in _NAME_TOKENS:
        if token.search(name):
            return measured
    return ""


def best(measured: str = "", name: str = "") -> str:
    """La clase final: la medida si existe, y si no, lo que diga el nombre."""
    return (measured or "").strip() or from_name(name)
