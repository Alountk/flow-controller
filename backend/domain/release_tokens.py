"""Quality/languages a release title itself declares, for the modal's chips.

The direct rows carry no arr fields, so Calidad/Idioma died moving the search
off the arr (odd/tasks/filtros-directos.md S1). These read ONLY tokens the
source's own title states: no token → None/[], never a guess (S5's honest
absence).

"""

from __future__ import annotations

import re

#: Radarr's quality names as `Container-Resolution`; BOTH tokens required, so
#: one without the other claims a class the title never declared.
_CONTAINER_PATTERNS: dict[str, str] = {
    "Bluray": r"blu[.\s-]?ray|bdremux|bdrip|brrip|remux",
    "WEBDL": r"web[.\s_-]?dl",
    "WEBRip": r"web[.\s_-]?rip",
    "HDTV": r"hdtv",
}

_CONTAINER_RES = {
    name: re.compile(rf"(?<![a-z0-9])(?:{pattern})(?![a-z0-9])", re.IGNORECASE)
    for name, pattern in _CONTAINER_PATTERNS.items()
}

_RESOLUTION_RE = re.compile(
    r"(?<![0-9])(?P<res>2160|1080|720|576|480)p(?![0-9a-z])", re.IGNORECASE
)

#: Canonical output order — deterministic whatever order the title mixes them.
_LANGUAGES: tuple[str, ...] = (
    "Spanish", "English", "Russian", "French", "German",
    "Italian", "Portuguese", "Japanese", "Chinese",
)

_FULL_WORDS: dict[str, str] = {
    "spanish": "Spanish",
    "español": "Spanish",
    "english": "English",
    "russian": "Russian",
    "french": "French",
    "german": "German",
    "italian": "Italian",
    "portuguese": "Portuguese",
    "japanese": "Japanese",
    "chinese": "Chinese",
}

#: Short codes count ONLY as standalone UPPERCASE tokens (Title-Case «Cast»
#: is a word, not CAST) and NEVER DUAL/DUALAUDIO — the pair is a guess.
_CODES: dict[str, str] = {
    "ESP": "Spanish", "CAST": "Spanish",
    "ENG": "English",
    "RUS": "Russian",
    "FRA": "French", "FRE": "French",
    "GER": "German", "DEU": "German",
    "ITA": "Italian",
    "PT": "Portuguese",
    "JPN": "Japanese",
    "CHN": "Chinese", "CHI": "Chinese",
}


def _alternation(words) -> str:
    return "|".join(sorted((re.escape(word) for word in words), key=len, reverse=True))


_WORD_RE = re.compile(rf"\b(?:{_alternation(_FULL_WORDS)})\b", re.IGNORECASE)
_CODE_RE = re.compile(rf"\b(?:{_alternation(_CODES)})\b")


def _leftmost_container(title: str) -> str | None:
    best: tuple[int, str] | None = None
    for name, pattern in _CONTAINER_RES.items():
        match = pattern.search(title)
        if match and (best is None or match.start() < best[0]):
            best = (match.start(), name)
    return best[1] if best else None


def quality_from_title(title: str) -> str | None:
    """`Container-Resolution` the title declares; None when it declares none."""
    container = _leftmost_container(title)
    resolution = _RESOLUTION_RE.search(title)
    if container is None or resolution is None:
        return None
    return f"{container}-{resolution.group('res')}p"


def languages_from_title(title: str) -> list[str]:
    """Languages the title declares, in canonical order; [] when it declares none."""
    found = {_FULL_WORDS[match.group(0).lower()] for match in _WORD_RE.finditer(title)}
    found.update(_CODES[match.group(0)] for match in _CODE_RE.finditer(title))
    return [language for language in _LANGUAGES if language in found]
