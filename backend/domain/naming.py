"""Evaluate Radarr's own naming pattern for a file Radarr cannot see itself.

Radarr only renames what it owns. `GET /api/v3/rename`, the `RenameMovie`
command and the `RenameFiles` command all operate on the library, so a file
copied into a folder outside Radarr's roots will never be offered a `newPath` —
and Radarr exposes no "what would this be called" endpoint either.

What it does expose is its pattern. Evaluating somebody else's format string
is exactly where a filename gets written *wrong with total confidence*, so this
module never trusts itself: `reproduced_radarr` re-evaluates the pattern for the
file Radarr already owns and compares the answer to the name Radarr computed.
Only a match earns the right to name a file we are about to write.

Supporting a token costs nothing when it is a guess: a wrong rendering shows up
as a mismatch in that same check and the whole thing falls back to the name the
app already uses. The tokens are bounded on purpose — `{Release Group}` and the
`{MEDIAINFO ...}` family describe a file we have not scanned, and filling them
in would be invention.
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import PurePosixPath

#: Pattern body -> the key it reads out of a value dict. Everything else is a
#: token we refuse to guess: see the module docstring.
_TOKENS = {
    "movie title": "title",
    "title": "title",
    "original title": "original_title",
    "title the": "title_the",
    "movie cleantitle": "clean_title",
    "movie clean title": "clean_title",
    "clean title": "clean_title",
    "release year": "year",
    "movie year": "year",
    "quality full": "quality",
    "quality": "quality",
    "quality-short": "quality_short",
    "quality short": "quality_short",
    "edition": "edition",
    "edition tags": "edition",
}

_GROUP_RE = re.compile(r"\{([^{}]*)\}")

#: `{Quality-Short}` in Sonarr/Radarr renders the container's initial plus the
#: resolution (`B720p`). A wrong spelling cannot ship: the self-check compares
#: it against the name Radarr already wrote.
_SHORT_CONTAINER = {
    "bluray": "B",
    "remux": "R",
    "webdl": "W",
    "webrip": "W",
    "hdtv": "H",
    "dvd": "D",
    "bdrip": "B",
    "brrip": "B",
}


def clean_title(title: str) -> str:
    """Radarr's `{Movie CleanTitle}`: no accents, no punctuation, lowercased.

    It has to match Radarr's spelling for the self-check to be meaningful, so
    this is deliberately literal rather than clever.
    """
    decomposed = unicodedata.normalize("NFKD", title or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]", "", stripped.lower())


def _the_form(title: str) -> str:
    """`{Title The}` moves a leading article to the end: `The Film` -> `Film, The`."""
    head, _, rest = (title or "").partition(" ")
    if head.lower() == "the" and rest:
        return f"{rest}, The"
    return title or ""


def _short_quality(quality: str) -> str:
    container, _, resolution = (quality or "").partition("-")
    letter = _SHORT_CONTAINER.get(container.lower(), container[:1])
    return f"{letter}{resolution}" if resolution else (quality or "")


def build_values(
    *,
    title: str,
    year: int | None,
    quality: str,
    original_title: str = "",
    edition: str = "",
) -> dict:
    """The only facts this module is allowed to use.

    `year` and `quality` are allowed to arrive empty: a pattern that asks for
    them then fails, which is the correct answer for a name we cannot compute.
    """
    title = (title or "").strip()
    quality = (quality or "").strip()
    return {
        "title": title,
        "year": year,
        "quality": quality,
        "quality_short": _short_quality(quality),
        "clean_title": clean_title(title),
        "title_the": _the_form(title),
        "original_title": (original_title or "").strip() or title,
        "edition": (edition or "").strip(),
    }


def _token_value(body: str, values: dict) -> tuple[str | None, bool]:
    """Resolve one token name -> (value or None, known).

    `known` separates "Radarr has this token and we have no data for it" from
    "we have never heard of it". Both may be omitted inside an optional group,
    but only the first is ever a *bare* token we are willing to leave out of a
    filename — and a bare one fails either way, because rendering it as nothing
    would silently shorten the name.
    """
    key = _TOKENS.get(re.sub(r"\s+", " ", body).strip().lower())
    if key is None:
        return None, False
    value = values.get(key)
    if value is None or value == "":
        return None, True
    return str(value), True


def _resolve_group(body: str, values: dict) -> tuple[str, bool]:
    """Resolve one `{...}` group -> (text, continue).

    `continue` is False only when a *bare* token could not be resolved, which
    means the whole evaluation has to fail rather than produce a shortened
    name. Optional (`{[...]}`) and conditional (`{-...}`) groups degrade to
    empty instead: that is what Radarr does when the data is not there.
    """
    inner = body.strip()
    optional = inner.startswith("[") and inner.endswith("]") and len(inner) > 2
    conditional = inner.startswith("-") and len(inner) > 1
    if optional or conditional:
        content = inner[1:-1] if optional else inner[1:]
        value, known = _token_value(content, values)
        if not known or value is None:
            return "", True
        if optional:
            return f"[{value}]", True
        return f"-{value}", True
    value, known = _token_value(inner, values)
    if not known or value is None:
        return "", False
    return value, True


def evaluate(pattern: str, values: dict) -> str | None:
    """Render `pattern` with `values`, or None when it cannot be rendered.

    None is the honest answer for a pattern this module does not fully
    understand. Returning a shortened string instead would write a filename
    that looks deliberate and is not.
    """
    if not pattern:
        return None
    out: list[str] = []
    cursor = 0
    for match in _GROUP_RE.finditer(pattern):
        out.append(pattern[cursor : match.start()])
        text, ok = _resolve_group(match.group(1), values)
        if not ok:
            return None
        out.append(text)
        cursor = match.end()
    out.append(pattern[cursor:])
    result = "".join(out)
    return result if result.strip() else None


def _basename(path: str) -> str:
    # Radarr runs on POSIX, but a value read from a config file may not be one.
    return PurePosixPath(str(path).replace("\\", "/")).name


#: Extensions Radarr adds itself: the pattern never carries one, so comparing
#: names has to ignore it. Restricting this to media extensions matters — a
#: bare `suffix` test would call `.PROPER` an extension and drop it from a
#: name that has one.
#:
#: Public (`MEDIA_EXTENSIONS`, promoted from `_MEDIA_EXTENSIONS`) because this
#: is the repo's single definition of "this file is a video": clients.py reads
#: it to tell a folder that holds a video from one holding only sidecars.
#: Two lists would drift, and the second one would silently stop matching.
MEDIA_EXTENSIONS = {
    ".mkv", ".mp4", ".avi", ".m2ts", ".ts", ".wmv", ".mov", ".m4v",
    ".mpg", ".mpeg", ".webm", ".flv", ".ogm", ".rmvb", ".divx", ".iso",
}


def _without_media_extension(path: str) -> str:
    name = _basename(path)
    candidate = PurePosixPath(name)
    if candidate.suffix.lower() in MEDIA_EXTENSIONS:
        return candidate.stem
    return name


def reproduced_radarr(pattern: str, values: dict, actual: str) -> bool:
    """Whether our evaluation agrees with the name Radarr already chose.

    `actual` is `movieFile.relativePath` — Radarr's own answer for the file it
    owns. Compared on the file name because the folder comes from
    `movie.path`, which is Radarr's answer too, and with the media extension
    stripped because Radarr appends that itself.

    This is the gate: without it we would be naming files after a format string
    we only believe we understand.
    """
    computed = evaluate(pattern, values)
    if computed is None or not actual:
        return False
    return _without_media_extension(computed) == _without_media_extension(actual)
