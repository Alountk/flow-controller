"""Radarr's `{MediaInfo …}` values, read from the file itself.

Radarr renders a name from what it probed: codec, bit depth, dynamic range,
audio and channels. We cannot ask it about a file it does not own, so the same
facts are read here with `media_mixer.probe_file`. Nothing is guessed from the
release name except the two things a probe cannot see — the source and the
group — and both come from Radarr's own fields or the name on disk.

Radarr's spellings are the contract: a name is only useful if it is the one
Radarr would have written, so `hevc` becomes `x265` and `dts` with the
`DTS-HD MA` profile stays `DTS-HD MA`.
"""

from __future__ import annotations

import re

_VIDEO_CODEC = {
    "hevc": "x265",
    "h264": "x264",
    "av1": "AV1",
    "vp9": "VP9",
    "vp8": "VP8",
    "mpeg2video": "MPEG-2",
    "vc1": "VC-1",
    "mpeg4": "XviD",
    "msmpeg4v3": "DivX",
}

_AUDIO_CODEC = {
    "truehd": "TrueHD",
    "eac3": "EAC3",
    "ac3": "AC3",
    "aac": "AAC",
    "flac": "FLAC",
    "opus": "Opus",
    "mp3": "MP3",
    "vorbis": "Vorbis",
    "pcm_s16le": "PCM",
    "pcm_s24le": "PCM",
}

#: Radarr writes channels as `5.1`, never as a count.
_CHANNELS = {1: "1.0", 2: "2.0", 3: "2.1", 4: "4.0", 6: "5.1", 8: "7.1"}

#: ISO 639-2 -> the 639-1 codes Radarr prints in `{MediaInfo AudioLanguages}`.
_LANG = {
    "spa": "es", "eng": "en", "rus": "ru", "fra": "fr", "fre": "fr", "deu": "de",
    "ger": "de", "ita": "it", "por": "pt", "jpn": "ja", "chi": "zh", "zho": "zh",
    "cat": "ca", "kor": "ko", "nld": "nl", "dut": "nl", "swe": "sv", "pol": "pl",
}

#: Transfer functions that mean high dynamic range; PQ is what HDR10 uses.
_HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}

_GROUP_RE = re.compile(r"-([A-Za-z0-9][A-Za-z0-9@._]{1,19})$")

#: A group is never one of these: they are tokens of the release, not its author.
_NOT_A_GROUP = {
    "x264", "x265", "h264", "h265", "hevc", "av1", "dts", "dtshd", "truehd",
    "eac3", "ac3", "aac", "flac", "atmos", "hdr", "dv", "sdr", "remux", "proper",
    "repack", "multi", "dual", "subs", "esp", "eng", "cast",
}


def _first(tracks: list[dict]) -> dict:
    return tracks[0] if tracks else {}


def video_codec(probe: dict) -> str:
    codec = (_first(probe.get("video_tracks") or []).get("codec") or "").lower()
    return _VIDEO_CODEC.get(codec, codec.upper() if codec else "")


def video_bit_depth(probe: dict) -> str:
    """Radarr's `10` / `8` / `12`, from the pix_fmt the probe reports."""
    pix_fmt = (_first(probe.get("video_tracks") or []).get("pix_fmt") or "").lower()
    match = re.search(r"(?:p|yuv\d{3}p|gbrp)(\d{2})(?:le|be)?$", pix_fmt)
    if match:
        return str(int(match.group(1)))
    return "8" if pix_fmt else ""


def video_dynamic_range(probe: dict) -> str:
    """`DV`, `HDR` or `SDR` — Radarr's own three words."""
    track = _first(probe.get("video_tracks") or [])
    if _is_dolby_vision(track):
        return "DV"
    transfer = (track.get("color_transfer") or "").lower()
    return "HDR" if transfer in _HDR_TRANSFERS else "SDR"


def _is_dolby_vision(track: dict) -> bool:
    profile = (track.get("profile") or "").lower()
    return "dolby vision" in profile or (track.get("color_transfer") or "").lower() == "dv"


def audio_codec(probe: dict) -> str:
    track = _first(probe.get("audio_tracks") or [])
    codec = (track.get("codec") or "").lower()
    profile = (track.get("profile") or "").upper()
    if codec == "dts":
        # ffprobe reports plain `dts` and keeps the flavour in the profile.
        return "DTS-HD MA" if "MA" in profile else ("DTS-X" if "X" in profile else "DTS")
    return _AUDIO_CODEC.get(codec, codec.upper() if codec else "")


def audio_channels(probe: dict) -> str:
    channels = int(_first(probe.get("audio_tracks") or []).get("channels") or 0)
    if not channels:
        return ""
    return _CHANNELS.get(channels, f"{channels}.0")


def audio_languages(probe: dict) -> str:
    return _languages(probe.get("audio_tracks") or [])


def subtitle_languages(probe: dict) -> str:
    return _languages(probe.get("subtitle_tracks") or [])


def _languages(tracks: list[dict]) -> str:
    seen: list[str] = []
    for track in tracks:
        code = _LANG.get((track.get("language") or "").lower())
        if code and code not in seen:
            seen.append(code)
    return "/".join(seen)


def resolution(probe: dict) -> str:
    """`2160` / `1080` / … from the picture itself, never from the name."""
    height = int(_first(probe.get("video_tracks") or []).get("height") or 0)
    for edge, label in ((1700, "2160"), (1000, "1080"), (700, "720"), (560, "576")):
        if height >= edge:
            return label
    return "480" if height else ""


def simple(probe: dict) -> str:
    """Radarr's `{MediaInfo Simple}`: codec depth range audio channels."""
    parts = [
        video_codec(probe),
        f"{video_bit_depth(probe)}bit" if video_bit_depth(probe) else "",
        video_dynamic_range(probe) if video_dynamic_range(probe) != "SDR" else "",
        audio_codec(probe),
        audio_channels(probe),
    ]
    return " ".join(part for part in parts if part)


def full(probe: dict) -> str:
    """Radarr's `{MediaInfo Full}`: the simple line plus its languages."""
    parts = [simple(probe), audio_languages(probe)]
    subtitles = subtitle_languages(probe)
    if subtitles:
        parts.append(f"subtitles {subtitles}")
    return " ".join(part for part in parts if part)


def release_group(name: str) -> str:
    """The group the file name ends with, or "" — a name cannot be invented.

    The tail of a scene name is the only place a group survives for a file
    Radarr does not own, and it is a declaration like the source token: what is
    refused are the tails that are plainly a resolution, an audio line or a
    release flag, because naming a file after `2160p` is worse than not naming
    the group at all.
    """
    stem = name.rsplit(".", 1)[0] if "." in name else name
    match = _GROUP_RE.search(stem)
    if not match:
        return ""
    group = match.group(1)
    if group.lower() in _NOT_A_GROUP or group[0].isdigit():
        return ""
    if re.search(r"\d{3,4}p", group, re.IGNORECASE) or re.search(r"\.\d", group):
        return ""
    return group


def compose(facts: dict) -> dict:
    """Fill `Simple` and `Full` from the other keys, whichever side produced them.

    Radarr sends the parts, not these two lines; a probe gives the parts too.
    Composing here keeps one spelling for both, which is what makes the
    self-check against Radarr's own file meaningful.
    """
    facts = {k: (v if v is not None else "") for k, v in facts.items()}
    parts = [
        facts.get("video_codec", ""),
        f"{facts['video_bit_depth']}bit" if facts.get("video_bit_depth") else "",
        facts.get("video_dynamic_range", "")
        if facts.get("video_dynamic_range") not in ("", "SDR")
        else "",
        facts.get("audio_codec", ""),
        facts.get("audio_channels", ""),
    ]
    simple = " ".join(part for part in parts if part)
    full = " ".join(
        part
        for part in (
            simple,
            facts.get("audio_languages", ""),
            f"subtitles {facts['subtitle_languages']}" if facts.get("subtitle_languages") else "",
        )
        if part
    )
    return {**facts, "simple": facts.get("simple") or simple, "full": facts.get("full") or full}


def from_probe(probe: dict, name: str) -> dict:
    """Everything the file itself can say about itself, keyed for the tokens."""
    return compose(
        {
            "video_codec": video_codec(probe),
            "video_bit_depth": video_bit_depth(probe),
            "video_dynamic_range": video_dynamic_range(probe),
            "video_dynamic_range_type": video_dynamic_range(probe),
            "audio_codec": audio_codec(probe),
            "audio_channels": audio_channels(probe),
            "audio_languages": audio_languages(probe),
            "subtitle_languages": subtitle_languages(probe),
            "release_group": release_group(name),
        }
    )


def quality(name: str, declared: str, fallback: str, probe: dict) -> str:
    """`Container-Resolution` with the resolution the disk reports.

    The container is the file's source, which only a name or Radarr can tell;
    the resolution is a fact about the picture, so the probe wins over both. A
    pattern that asked for 2160p while Radarr stores the 1080p file gets the
    copy's own number, which is the whole point of reading the file.
    """
    container = _container(name, declared) or (fallback or "").partition("-")[0]
    pixels = resolution(probe) or (declared or "").partition("-")[2] or (
        fallback or ""
    ).partition("-")[2]
    pixels = pixels.replace("p", "")
    if not container or not pixels:
        return ""
    return f"{container}-{pixels}p"


def _container(name: str, declared: str) -> str:
    """Radarr keeps a remux as its own quality (`Remux-2160p`), not as a Bluray."""
    if re.search(r"(?<![a-z0-9])remux(?![a-z0-9])", name or "", re.IGNORECASE):
        return "Remux"
    return (declared or "").partition("-")[0]
