"""Rename a library copy Radarr cannot see, and say how sure we are.

Radarr renames what it owns and nothing else: a copy sitting in the 4K or 3D
root has no `movieFile` row, so `RenameMovie` never offers it a name. What
Radarr does expose is its pattern and, for the movie it tracks, the folder and
file name it already chose.

So the proposal is built from those two, and the pattern only gets to name a
file when it reproduces the name Radarr already wrote — the same gate
`copy_engine` uses before it writes a copy.

The rest of this module is the irreversible half: refuse collisions, stay
inside the root, honour the seed guard, and report every file it moved so the
rename can be undone by hand.
"""

from __future__ import annotations

import os
from pathlib import Path
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Iterable, Iterator

from domain import media_info, naming
from domain import rename_plan
from domain.release_tokens import quality_from_title

#: Why `path` may not be renamed — injected so the route owns config and the
#: guard's torrent root, exactly like `/api/files/rename` already does.
Blocked = Callable[[str, str], "str | None"]


def refusal(detail: str) -> dict:
    return {"ok": False, "detail": detail}


def _real(path: str) -> str:
    return os.path.realpath(path)


def in_root(path: str, roots: Iterable[str]) -> str:
    """The root `path` belongs to, or "" — compared on real paths."""
    real = _real(path)
    for root in roots:
        if not root:
            continue
        real_root = _real(root)
        if real == real_root or real.startswith(real_root + "/"):
            return root
    return ""


def match_movie(stem: str, movies: list[dict]) -> tuple[dict | None, str]:
    """The one movie whose title and year open `stem`, or None and why not.

    Exact after cleaning (`naming.clean_title`), never substring: `Aliens` must
    not be claimed by `Alien`. A tie is refused rather than guessed — two
    movies that both fit would mean renaming one film after another.
    """
    wanted = naming.clean_title(stem)
    if not wanted:
        return None, "el nombre del archivo no deja nada con lo que identificar la película"

    hits: list[dict] = []
    for movie in movies:
        title = (movie.get("title") or "").strip()
        if not title:
            continue
        year = movie.get("year")
        key = naming.clean_title(f"{title} {year}" if year else title)
        if key and wanted.startswith(key):
            hits.append(movie)

    if len(hits) == 1:
        return hits[0], ""
    if not hits:
        return None, "no coincide ninguna película del catálogo con el nombre del archivo"
    titles = ", ".join(sorted(str(m.get("title") or "") for m in hits))
    return None, f"varias películas encajan: {titles}"


def _folder_of(movie: dict) -> str:
    """Radarr's own folder for the movie — the answer it already acted on."""
    path = (movie.get("path") or "").strip()
    return os.path.basename(path) if path else ""


def proposal(
    *,
    video_path: str,
    movies: list[dict],
    naming_cfg: dict,
    siblings: Iterable[str],
    roots: Iterable[str],
    chosen_movie: dict | None = None,
    probe: Callable[[str], dict] | None = None,
) -> dict:
    """What the dialog should prefill: folder, name, sidecars and warnings.

    Everything is a suggestion the user can edit, so a doubt is a warning, not
    a failure. Only an unreadable file is a failure — there is nothing to
    propose for it. `chosen_movie` is the movie the user picked by hand: naming
    the film is exactly the proof the pattern gate otherwise has to find on its
    own, so an identified movie is enough to fill a name in.
    """
    if not os.path.isfile(video_path):
        return refusal(f"No se pudo leer el archivo: {video_path}")

    roots = list(roots)
    name = os.path.basename(video_path)
    extension = Path(name).suffix
    stem = rename_plan.base_name(name)
    loose = _real(os.path.dirname(video_path)) in {_real(r) for r in roots if r}

    pattern = (naming_cfg or {}).get("standard_movie_format", "") or ""
    folder_pattern = (naming_cfg or {}).get("movie_folder_format", "") or ""
    declared_quality = quality_from_title(name) or ""
    # The group is written in the name, so it survives without a probe; only the
    # `{MediaInfo …}` family needs the file itself.
    facts: dict = {"release_group": media_info.release_group(name)}
    raw_probe: dict = {}
    probed = False
    warnings_probe = ""
    if probe is not None:
        try:
            raw_probe = probe(video_path)
            facts.update(media_info.from_probe(raw_probe, name))
            probed = True
        except Exception as exc:  # ffprobe is external: any failure means "not read"
            warnings_probe = f"no se pudo leer el archivo para rellenar el nombre: {exc}"
    quality = (
        media_info.quality(name, declared_quality, "", raw_probe or facts)
        if probed
        else declared_quality
    )

    warnings: list[str] = []
    if warnings_probe:
        warnings.append(warnings_probe)
    movie, reason = (
        (chosen_movie, "") if chosen_movie is not None else match_movie(stem, movies)
    )
    proposed_stem = stem
    folder = ""
    # Whether the template proved it can write this movie's name. Without that
    # proof a copy is not relocated either: moving a file we cannot name gives
    # a half rename —a tidier folder around the same scene name— and reads as
    # though the rename failed.
    named = False

    if movie is None:
        warnings.append(reason)
    else:
        if not quality:
            quality = (movie.get("quality") or "").strip()
            if quality:
                warnings.append("el nombre del archivo no declara calidad; se usó la de Radarr")

        reference = naming.build_values(
            title=movie.get("title", ""),
            year=movie.get("year"),
            quality=movie.get("quality", ""),
            # Radarr's own file, not our copy: the gate re-renders Radarr's
            # pattern against the file Radarr named, and only Radarr knows it.
            media_info=movie.get("media_info") or {},
        )
        reproduced = bool(pattern) and naming.reproduced_radarr(
            pattern, reference, movie.get("file_name", "")
        )
        # A movie chosen by hand lifts the gate; the preview is still shown and
        # still editable, so the person can see what the template wrote.
        trusted = reproduced or chosen_movie is not None
        if chosen_movie is not None and not reproduced:
            warnings.append(
                "elegiste la película a mano: se aplicó la plantilla sin comprobarla "
                "contra el archivo que Radarr tiene de ella"
            )
        if not pattern:
            warnings.append("Radarr no expone un patrón de nombrado; se propone el nombre actual")
        elif not trusted:
            warnings.append(
                "la plantilla de Radarr no se pudo reproducir con el archivo de esa película; "
                "se propone el nombre actual"
            )
        else:
            values = naming.build_values(
                title=movie.get("title", ""),
                year=movie.get("year"),
                quality=quality,
                media_info=facts,
            )
            # A measured pattern rendered without a probe would be a name with
            # holes in it — and the self-check would pass, because it compares
            # Radarr's file, not ours. Refuse instead.
            unread = naming.needs_file_facts(pattern) and not probed
            rendered = None if unread else naming.evaluate(pattern, values)
            if rendered:
                proposed_stem = Path(rendered).name
                named = True
            else:
                gaps = naming.missing(pattern, values)
                warnings.append(
                    "la plantilla pide datos que este archivo no dio: " + ", ".join(gaps)
                    if gaps
                    else "la plantilla no se pudo evaluar con la calidad de esta copia"
                )

        if loose and named:
            folder = _folder_of(movie)
            if not folder and folder_pattern:
                folder = naming.evaluate(
                    folder_pattern,
                    naming.build_values(
                        title=movie.get("title", ""), year=movie.get("year"), quality=quality
                    ),
                ) or ""
            if not folder:
                warnings.append("no se pudo deducir el nombre de la carpeta: escríbelo")

    sidecars = [
        {"from": s, "to": rename_plan.sidecar_target(name, s, proposed_stem)}
        for s in rename_plan.sidecars(name, siblings)
    ]

    return {
        "ok": True,
        "src": video_path,
        "loose": loose,
        "named": named,
        "folder": folder,
        "name": proposed_stem,
        "extension": extension,
        "sidecars": sidecars,
        "warnings": warnings,
        "movie": (
            {"id": movie.get("id"), "title": movie.get("title"), "year": movie.get("year")}
            if movie
            else None
        ),
        "detail": "",
    }


def search_movies(query: str, movies: list[dict], limit: int = 12) -> list[dict]:
    """The catalog rows a person can pick from, best first.

    Cleaned startswith before substring: someone typing `alien` means Alien, not
    a film whose Spanish title happens to contain the word.
    """
    wanted = naming.clean_title(query or "")
    if not wanted:
        return []

    starts: list[dict] = []
    inside: list[dict] = []
    for movie in movies:
        title = (movie.get("title") or "").strip()
        if not title:
            continue
        year = movie.get("year")
        key = naming.clean_title(f"{title} {year}" if year else title)
        if key.startswith(wanted):
            starts.append(movie)
        elif wanted in key:
            inside.append(movie)

    by_title = lambda m: (str(m.get("title") or "").lower(), m.get("year") or 0)  # noqa: E731
    rows = sorted(starts, key=by_title) + sorted(inside, key=by_title)
    return [
        {
            "id": m.get("id"),
            "title": m.get("title"),
            "year": m.get("year"),
            "folder": _folder_of(m),
            "quality": (m.get("quality") or "").strip(),
        }
        for m in rows[:limit]
    ]


def find_movie(movie_id: int, movies: list[dict]) -> dict | None:
    for movie in movies:
        if movie.get("id") == movie_id:
            return movie
    return None


def _targets(
    src: Path, folder: str, stem: str, siblings: Iterable[str]
) -> tuple[Path, list[tuple[str, Path]]]:
    """Where the video and each sidecar go, without deciding whether they may."""
    parent = src.parent / folder if folder else src.parent
    plan = [(src.name, parent / f"{stem}{src.suffix}")]
    for sibling in rename_plan.sidecars(src.name, siblings):
        plan.append((sibling, parent / rename_plan.sidecar_target(src.name, sibling, stem)))
    return parent, plan


def apply_rename(
    *,
    video_path: str,
    folder: str,
    stem: str,
    siblings: Iterable[str],
    roots: Iterable[str],
    blocked: Blocked,
) -> dict:
    """Rename the video and its sidecars into `folder`, or move nothing.

    Collisions are checked for the whole set before the first `os.rename`, and
    every rename is reported: `os.rename` replaces the target silently, so an
    unguarded name is not a rename, it is a deletion.
    """
    src = Path(video_path)
    if not src.is_file():
        return refusal(f"No es un archivo: {video_path}")

    real_src = _real(str(src))
    if not in_root(real_src, roots):
        return refusal(f"El archivo no está dentro de una raíz 4K/3D: {video_path}")

    clean_folder = ""
    if folder.strip():
        clean_folder = rename_plan.folder_name(folder) or ""
        if not clean_folder:
            return refusal(f"Nombre de carpeta no válido: {folder}")

    clean_stem = rename_plan.file_stem(stem)
    if not clean_stem:
        return refusal(f"Nombre de archivo no válido: {stem}")

    guard = blocked(real_src, "renombrar")
    if guard:
        return refusal(guard)

    parent, plan = _targets(src, clean_folder, clean_stem, siblings)
    if not in_root(str(parent), roots):
        return refusal(f"El destino se sale de la raíz: {parent}")
    if os.path.lexists(parent) and not os.path.isdir(parent):
        return refusal(f"Ya existe un archivo con el nombre de la carpeta: {parent.name}")

    # Two targets that differ only by case are one file on a case-insensitive
    # volume (APFS, CIFS), and `os.rename` would replace the first with the
    # second. The comparison is the only place that can be caught.
    folded = [str(target).casefold() for _, target in plan]
    if len(set(folded)) != len(folded):
        return refusal("Dos archivos acabarían con el mismo nombre: no se renombra nada")

    for _, target in plan:
        if os.path.lexists(target):
            return refusal(f"Ya existe {target.name}: no se sobreescribe")

    moved: list[dict] = []
    failed: list[dict] = []
    try:
        parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return refusal(f"{type(exc).__name__}: {exc}")

    for name, target in plan:
        source = src.parent / name
        if name != src.name and not source.exists():
            continue
        try:
            os.rename(source, target)
            moved.append({"from": str(source), "to": str(target)})
        except OSError as exc:
            failed.append({"name": name, "detail": f"{type(exc).__name__}: {exc}"})

    if not moved:
        return refusal(failed[0]["detail"] if failed else "No se renombró nada")

    detail = f"Renombrado: {moved[0]['from']} → {moved[0]['to']}"
    if failed:
        detail += "; no se pudo: " + ", ".join(f["name"] for f in failed)
    return {"ok": True, "moved": moved, "failed": failed, "detail": detail}


def _iter_videos(root: str) -> Iterator[tuple[str, list[str]]]:
    """(video path, sibling names) for each video in `root`, two levels deep.

    That is the shape of the library: a copy loose in the root, or one inside
    its movie folder. Deeper is an extras/season structure and not our business.
    """
    for entry in _walk(root, depth=2):
        yield entry


def _walk(directory: str, depth: int, seen: set[str] | None = None) -> Iterator[tuple[str, list[str]]]:
    seen = seen if seen is not None else set()
    real = _real(directory)
    if real in seen or depth < 0:
        return
    seen.add(real)
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return
    if any(Path(n).suffix.lower() in naming.MEDIA_EXTENSIONS for n in names):
        videos = [
            n for n in names
            if Path(n).suffix.lower() in naming.MEDIA_EXTENSIONS
            and os.path.isfile(os.path.join(directory, n))
        ]
        for name in videos:
            yield os.path.join(directory, name), names
    if depth == 0:
        return
    for name in names:
        child = os.path.join(directory, name)
        if os.path.isdir(child) and not os.path.islink(child):
            yield from _walk(child, depth - 1, seen)


#: ffprobe costs ~0.3 s a file and the same copy is asked about on every refresh
#: and on apply. Keyed by what makes the answer stale, never by path alone.
_PROBE_CACHE: "dict[tuple[str, int, int], dict]" = {}
_PROBE_LOCK = threading.Lock()
_PROBE_CACHE_MAX = 4096


def _probe_key(path: str) -> tuple[str, int, int]:
    stat = os.stat(path)
    return (os.path.realpath(path), stat.st_mtime_ns, stat.st_size)


def cached_probe(probe: Callable[[str], dict]) -> Callable[[str], dict]:
    """Wrap a probe so a copy is read once per (path, mtime, size)."""

    def read(path: str) -> dict:
        key = _probe_key(path)
        with _PROBE_LOCK:
            hit = _PROBE_CACHE.get(key)
        if hit is not None:
            return hit
        facts = probe(path)
        with _PROBE_LOCK:
            if len(_PROBE_CACHE) >= _PROBE_CACHE_MAX:
                _PROBE_CACHE.clear()
            _PROBE_CACHE[key] = facts
        return facts

    return read


def _probe_all(paths: list[str], read: Callable[[str], dict]) -> Callable[[str], dict]:
    """Read every copy in parallel and answer from the results, failures included.

    A failing file must fail the same way it would have on its own, so each
    result carries either the facts or the exception that kept them away.
    """

    def one(path: str):
        try:
            return path, read(path), None
        except Exception as exc:  # reported per file, never for the whole batch
            return path, None, exc

    workers = min(8, max(1, len(paths)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = {path: (facts, exc) for path, facts, exc in pool.map(one, paths)}

    def answer(path: str) -> dict:
        facts, exc = results.get(path, (None, None))
        if exc is not None:
            raise exc
        if facts is None:
            raise OSError("no se leyó el archivo")
        return facts

    return answer


def candidates(
    *,
    roots: Iterable[str],
    movies: list[dict],
    naming_cfg: dict,
    probe: Callable[[str], dict] | None = None,
) -> dict:
    """Every 4K/3D copy that does NOT already follow Radarr's template (S2).

    A copy whose proposal matches what it already is does not appear. One that
    could not be proposed appears WITH its warning and `ok: false` (S5): hiding
    it would make the library look complete when it is not.
    """
    roots = [r for r in roots if r]
    found: list[tuple[str, list[str]]] = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        found.extend(_iter_videos(root))

    # S2: only when the pattern asks for what the name cannot answer, and then
    # the whole list at once rather than one file per row.
    read: Callable[[str], dict] | None = None
    pattern = (naming_cfg or {}).get("standard_movie_format", "") or ""
    if probe is not None and found and naming.needs_file_facts(pattern):
        read = _probe_all([path for path, _ in found], cached_probe(probe))

    items: list[dict] = []
    scanned = 0
    for video_path, siblings in found:
        scanned += 1
        got = proposal(
            video_path=video_path,
            movies=movies,
            naming_cfg=naming_cfg,
            siblings=siblings,
            roots=roots,
            probe=read,
        )
        if got["ok"]:
            current = rename_plan.base_name(os.path.basename(video_path))
            # Unidentifiable is not "done": nothing was proposed for it, so
            # hiding it would make the root look finished when it is not.
            needs_work = (
                got["movie"] is None
                or not got["named"]
                or got["name"] != current
                or (got["loose"] and bool(got["folder"]))
            )
            if not needs_work:
                continue
        items.append(got)
    items.sort(key=lambda item: str(item.get("src") or ""))
    return {"ok": True, "items": items, "scanned": scanned, "detail": ""}
