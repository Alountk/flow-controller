"""Score a folder scan against wanted titles — the CPU cost behind a thin route.

One module for the matching work that used to live inside the HTTP handler of
`interfaces/http/routes/wanted.py` (T3): the route validates the path, fetches
the arr's titles, then hands the target and the walk here and maps the returned
tuple to its response. The enumeration itself is injected (`ScanWalk`) —
`os.walk` lives in `infrastructure.wanted_scan`, because a syscall in a handler
is a syscall you cannot reach without HTTP.

Behaviour is the route's behaviour, kept byte for byte: video-only scanning,
the 0.5 threshold, the containment bonuses, and the match payload the frontend
has always drawn — best score first.
"""

from __future__ import annotations

import os
import re
import unicodedata

from application.ports import ScanWalk

#: Files the scan considers worth scoring.
VIDEO_EXTS = {'.mkv', '.mp4', '.avi', '.wmv', '.flv', '.mov', '.m4v', '.ts', '.mpg', '.mpeg'}

#: Below this similarity a filename is not a candidate for the title.
MATCH_THRESHOLD = 0.5


def normalize_title(name: str) -> str:
    """Normaliza un nombre de archivo para comparación fuzzy."""
    if not isinstance(name, str):
        name = str(name) if name else ""
    if not name:
        return ""
    # Quitar extensión
    name = re.sub(r'\.[a-zA-Z0-9]{2,4}$', '', name)
    # Reemplazar puntos y guiones bajos por espacios
    name = re.sub(r'[._]', ' ', name)
    # Quitar calidad: 1080p, 720p, 2160p, BluRay, WEB-DL, etc.
    name = re.sub(r'\b(2160p|1080p|720p|480p|4k|bluray|web-?dl|webrip|hdtv|dvdrip|h264|h265|x264|x265|hevc|aac|dts|ac3|remux)\b', '', name, flags=re.IGNORECASE)
    # Quitar year entre paréntesis o solo
    name = re.sub(r'[\(\[]?\d{4}[\)\]]?', '', name)
    # Quitar grupos de release
    name = re.sub(r'[-@][A-Za-z0-9]+$', '', name)
    # Normalizar unicode (quitar acentos)
    name = unicodedata.normalize('NFD', name)
    name = ''.join(c for c in name if unicodedata.category(c) != 'Mn')
    # Minúsculas y limpiar espacios
    name = name.lower().strip()
    name = re.sub(r'\s+', ' ', name)
    return name


def _match_score(filename: str, title: str) -> float:
    """Calcula similitud entre nombre de archivo y título. Retorna 0-1."""
    from difflib import SequenceMatcher
    norm_file = normalize_title(filename)
    norm_title = normalize_title(title)
    if not norm_file or not norm_title:
        return 0.0
    # Ratio básico
    ratio = SequenceMatcher(None, norm_file, norm_title).ratio()
    # Bonus si el título está contenido en el nombre del archivo
    if norm_title in norm_file:
        ratio = max(ratio, 0.85)
    # Bonus si el nombre del archivo está contenido en el título
    if norm_file in norm_title:
        ratio = max(ratio, 0.80)
    return round(ratio, 3)


def scan_wanted_files(target: str, title_map: dict, *, walk: ScanWalk) -> tuple[list[dict], int]:
    """Walk `target` and score every video against every wanted title.

    CPU-bound (O(videos x titles) `SequenceMatcher.ratio()`) and pure
    filesystem work: a folder of a few thousand files against a couple of
    hundred titles is millions of ratio() calls. The route keeps the call on
    `asyncio.to_thread` because there is only one loop and it does not preempt
    — inline, every other request waits for the whole walk.
    """
    scanned_files = 0
    matches = []

    for root, _dirs, files in walk(target):
        for fname in files:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in VIDEO_EXTS:
                continue
            scanned_files += 1
            full_path = os.path.join(root, fname)

            best_score = 0.0
            best_match = None
            for norm_title, info in title_map.items():
                score = _match_score(fname, info["title_used"])
                if score > best_score:
                    best_score = score
                    best_match = info

            if best_match and best_score >= MATCH_THRESHOLD:
                target_path = best_match.get("movie_path", "")
                matches.append({
                    "file_path": full_path,
                    "file_name": fname,
                    "movie_id": best_match["movie_id"],
                    "movie_title": best_match["movie_title"],
                    "movie_year": best_match["movie_year"],
                    "target_path": target_path,
                    "score": best_score,
                    "matched_title": best_match["title_used"],
                })

    matches.sort(key=lambda m: m["score"], reverse=True)
    return matches, scanned_files
