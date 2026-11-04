"""La regla de los duplicados reales: dos ficheros de vídeo en la misma carpeta.

El caso que la destapó es del usuario, literal: dos ficheros 1080p en la carpeta
de «Now You See Me (2013)», de los cuales Radarr sólo conoce uno.
"""

from domain.duplicates_folders import duplicate_folders, resolution_class

FOLDER = "/mnt/storage/movies/es/Now You See Me (2013)"
WEBRIP = f"{FOLDER}/Now You See Me (2013) WEBRip-1080p - h265 DTS - [ES+EN].mkv"
WEBDL = f"{FOLDER}/Now You See Me (2013) WEBDL-1080p - h265 TrueHD Atmos - [EN+ES].mkv"


def test_two_1080p_files_in_one_folder_are_a_duplicate():
    groups = duplicate_folders(
        [{"path": WEBRIP, "size": 2_100}, {"path": WEBDL, "size": 2_300}],
        known={FOLDER: "Now You See Me (2013) WEBRip-1080p - h265 DTS - [ES+EN].mkv"},
        titles={FOLDER: "Now You See Me"},
    )

    assert len(groups) == 1
    group = groups[0]
    assert group["title"] == "Now You See Me"
    assert group["class"] == "1080"
    assert len(group["files"]) == 2


def test_the_file_radarr_knows_is_marked_and_the_other_is_what_you_can_reclaim():
    groups = duplicate_folders(
        [{"path": WEBRIP, "size": 2_100}, {"path": WEBDL, "size": 2_300}],
        known={FOLDER: "Now You See Me (2013) WEBRip-1080p - h265 DTS - [ES+EN].mkv"},
    )

    def find(token):
        return next(f for f in groups[0]["files"] if token in f["name"])

    assert find("WEBRip-1080p")["known"] is True
    assert find("WEBDL-1080p")["known"] is False
    # Sólo lo que Radarr no conoce es reclamable: borrar el otro dejaría la
    # película huérfana en el arr.
    assert groups[0]["reclaimable"] == 2_300


def test_different_qualities_are_not_a_duplicate():
    """Decisión del usuario: un 4K y un 1080p de la misma película no se tocan."""
    four_k = f"{FOLDER}/Now You See Me (2013) Bluray-2160p.mkv"

    groups = duplicate_folders(
        [{"path": WEBRIP, "size": 2_100}, {"path": four_k, "size": 9_000}],
        known={FOLDER: "Now You See Me (2013) WEBRip-1080p - h265 DTS - [ES+EN].mkv"},
    )

    assert groups == []


def test_a_folder_with_one_file_is_not_a_duplicate():
    assert duplicate_folders([{"path": WEBRIP, "size": 2_100}], known={}) == []


def test_an_orphan_folder_radarr_does_not_know_is_still_reported():
    """Carpeta que Radarr ya no conoce: el nombre de la carpeta hace de título."""
    other = "/mnt/storage-6tb/movies/old/Heat (1995)"
    groups = duplicate_folders([
        {"path": f"{other}/Heat (1995) 1080p.mkv", "size": 10},
        {"path": f"{other}/Heat (1995) 1080p.x264.mkv", "size": 20},
    ], known={})

    assert len(groups) == 1
    assert groups[0]["title"] == "Heat (1995)"
    assert all(f["known"] is False for f in groups[0]["files"])


def test_subtitles_and_other_files_never_count():
    """Sólo vídeo: un .srt junto al .mkv no es un duplicado."""
    groups = duplicate_folders([
        {"path": WEBRIP, "size": 2_100},
        {"path": f"{FOLDER}/Now You See Me (2013).es.srt", "size": 40},
    ], known={})

    # El .srt no lo pone el recorrido (filtra por extensión), pero si llegara,
    # cae en «otros» y queda solo en su clase: no hay grupo.
    assert groups == []


def test_same_file_name_is_kept_per_class_and_sorted_by_what_you_reclaim():
    a = "/mnt/storage/movies/a/Film (2001)"
    b = "/mnt/storage/movies/b/Other (2002)"
    groups = duplicate_folders(
        [{"path": f"{a}/Film 1080p.mkv", "size": 10}, {"path": f"{a}/Film 1080p CD2.mkv", "size": 10},
         {"path": f"{b}/Other 2160p.mkv", "size": 90}, {"path": f"{b}/Other 2160p CD2.mkv", "size": 99}],
        known={},
    )

    assert [g["folder"] for g in groups] == [b, a]


def test_resolution_class_reads_the_widest_token():
    assert resolution_class("Film 2160p.mkv") == "4K"
    assert resolution_class("Film 4K.mkv") == "4K"
    assert resolution_class("Film 1080p 3D.mkv") == "3D"
    assert resolution_class("Film 1080p.mkv") == "1080"
    assert resolution_class("Film 720p.mkv") == "otros"
    assert resolution_class("Film.mkv") == "otros"


def test_with_radarr_down_nothing_is_marked_or_reclaimable():
    """Sin datos del arr, «sobra» sería una mentira: se calla y no suma nada.

    Con el arr caído todo fichero parecía borrable, incluido el que Radarr
    conoce. La pantalla invitaba justo al borrado equivocado.
    """
    groups = duplicate_folders(
        [{"path": WEBRIP, "size": 2_100}, {"path": WEBDL, "size": 2_300}],
        known={},
        radarr_available=False,
    )

    assert [f["known"] for f in groups[0]["files"]] == [None, None]
    assert groups[0]["reclaimable"] == 0


def test_the_file_that_is_spare_is_listed_first():
    """El primer botón «Borrar» de una fila no puede ser el que rompe el arr."""
    groups = duplicate_folders(
        [{"path": WEBRIP, "size": 2_100}, {"path": WEBDL, "size": 2_300}],
        known={FOLDER: "Now You See Me (2013) WEBRip-1080p - h265 DTS - [ES+EN].mkv"},
    )

    first, second = groups[0]["files"]
    assert first["known"] is False and "WEBDL" in first["name"]
    assert second["known"] is True
