from domain import amule_torrent

ROW = {
    "hash": "ABCDEF0123456789ABCDEF0123456789", "name": "Movie.2001.avi", "size_full": 1000,
    "size_done": 250, "speed": 50, "eta_seconds": 15, "state": "downloading", "category": 2, "sources": 7,
}


def test_a_queue_row_reads_like_a_client_torrent():
    torrent = amule_torrent.from_row(ROW, {2: "radarr"}, "/incoming")
    assert torrent == {
        "hash": "abcdef0123456789abcdef0123456789", "name": "Movie.2001.avi", "state": "downloading",
        "progress": 0.25, "dlspeed": 50, "eta": 15, "size": 1000, "category": "radarr",
        "save_path": "/incoming", "num_seeds": 7, "source": "amule",
    }


def test_an_uncategorised_or_empty_row_never_invents_values():
    torrent = amule_torrent.from_row({"state": "paused", "category": None}, {}, "/incoming")
    assert torrent["category"] is None and torrent["progress"] == 0 and torrent["state"] == "pausedDL"


def test_a_finished_download_is_complete_and_keeps_its_name_as_identity():
    done = amule_torrent.completed("Movie.2001.avi", "/incoming")
    assert done["progress"] == 1.0 and done["hash"] == "amule:Movie.2001.avi"
    assert amule_torrent.completed("x", "/i", "ABC")["hash"] == "abc"
