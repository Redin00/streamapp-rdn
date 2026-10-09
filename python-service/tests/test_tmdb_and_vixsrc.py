import unittest
from unittest.mock import MagicMock, patch
from fastapi import HTTPException

import main


class TestTmdbAndVixsrc(unittest.TestCase):
    def setUp(self):
        main._cache.clear()
        main.clear_db_cache()

    def test_summary_from_tmdb_movie(self):
        item = {
            "id": 533535,
            "title": "Deadpool & Wolverine",
            "media_type": "movie",
            "release_date": "2024-07-24",
            "vote_average": 7.7,
            "poster_path": "/8cdWjvZQUExUUTzyp4t6EDMubfO.jpg",
            "backdrop_path": "/yDHYTfA3R0jFYba16jBB1ef8oIt.jpg",
            "genre_ids": [28, 35, 878],
        }
        summary = main.summary_from_tmdb(item)
        self.assertEqual(summary["id"], 533535)
        self.assertEqual(summary["name"], "Deadpool & Wolverine")
        self.assertEqual(summary["type"], "movie")
        self.assertEqual(summary["year"], 2024)
        self.assertEqual(summary["score"], 7.7)
        self.assertTrue(summary["posterUrl"].endswith("/8cdWjvZQUExUUTzyp4t6EDMubfO.jpg"))
        self.assertTrue(summary["backdropUrl"].endswith("/yDHYTfA3R0jFYba16jBB1ef8oIt.jpg"))
        self.assertIn("Azione", summary["genres"])
        self.assertIn("Commedia", summary["genres"])
        self.assertIn("Fantascienza", summary["genres"])
        self.assertIn("533535", summary["slug"])

    def test_summary_from_tmdb_tv(self):
        item = {
            "id": 94605,
            "name": "Arcane",
            "media_type": "tv",
            "first_air_date": "2021-11-06",
            "vote_average": 8.8,
            "poster_path": "/fqldf2t8ztc9aiwn39Rbm3Ft4j7.jpg",
            "backdrop_path": None,
            "genre_ids": [16, 10765, 10759],
            "number_of_seasons": 2,
        }
        summary = main.summary_from_tmdb(item)
        self.assertEqual(summary["id"], 94605)
        self.assertEqual(summary["name"], "Arcane")
        self.assertEqual(summary["type"], "tv")
        self.assertEqual(summary["year"], 2021)
        self.assertEqual(summary["score"], 8.8)
        self.assertEqual(summary["seasonsCount"], 2)

    def test_detail_from_tmdb_movie(self):
        data = {
            "id": 550,
            "title": "Fight Club",
            "release_date": "1999-10-15",
            "vote_average": 8.4,
            "overview": "A ticking-time-bomb insomniac...",
            "runtime": 139,
            "status": "Released",
            "genres": [{"id": 18, "name": "Dramma"}],
            "credits": {"cast": [{"name": "Edward Norton"}, {"name": "Brad Pitt"}]},
            "videos": {
                "results": [
                    {"site": "YouTube", "type": "Trailer", "key": "O1DTD_A2428"}
                ]
            },
            "imdb_id": "tt0137523",
        }
        detail = main.detail_from_tmdb(data, "movie")
        self.assertEqual(detail["id"], 550)
        self.assertEqual(detail["tmdbId"], 550)
        self.assertEqual(detail["imdbId"], "tt0137523")
        self.assertEqual(detail["name"], "Fight Club")
        self.assertEqual(detail["quality"], "HD")
        self.assertEqual(detail["runtime"], 139)
        self.assertEqual(detail["status"], "Released")
        self.assertEqual(detail["cast"], ["Edward Norton", "Brad Pitt"])
        self.assertEqual(detail["trailerUrl"], "https://www.youtube.com/watch?v=O1DTD_A2428")
        self.assertEqual(detail["seasons"], [])

    @patch("main.tmdb_get")
    def test_detail_from_tmdb_tv_with_seasons(self, mock_tmdb_get):
        mock_tmdb_get.return_value = {
            "season_number": 1,
            "episodes": [
                {"id": 101, "episode_number": 1, "name": "Episodio 1", "overview": "Plot 1", "runtime": 42},
                {"id": 102, "episode_number": 2, "name": "Episodio 2", "overview": "Plot 2", "runtime": 45},
            ]
        }
        data = {
            "id": 1396,
            "name": "Breaking Bad",
            "first_air_date": "2008-01-20",
            "vote_average": 8.9,
            "overview": "A chemistry teacher diagnosed with cancer...",
            "status": "Ended",
            "genres": [{"id": 18, "name": "Dramma"}],
            "seasons": [
                {"season_number": 0, "name": "Speciali"},
                {"season_number": 1, "name": "Stagione 1"},
            ],
            "credits": {"cast": [{"name": "Bryan Cranston"}]},
            "videos": {"results": []},
        }
        detail = main.detail_from_tmdb(data, "tv")
        self.assertEqual(detail["id"], 1396)
        self.assertEqual(detail["type"], "tv")
        self.assertEqual(len(detail["seasons"]), 1)
        self.assertEqual(detail["seasons"][0]["number"], 1)
        self.assertEqual(len(detail["seasons"][0]["episodes"]), 2)
        self.assertEqual(detail["seasons"][0]["episodes"][0]["number"], 1)

    def test_tmdb_get_raises_503_when_no_api_key(self):
        orig_key = main.TMDB_API_KEY
        try:
            main.TMDB_API_KEY = ""
            with patch.dict("os.environ", {"TMDB_API_KEY": ""}):
                with self.assertRaises(HTTPException) as ctx:
                    main.tmdb_get("/movie/550")
                self.assertEqual(ctx.exception.status_code, 503)
                self.assertIn("TMDB_API_KEY is not configured", ctx.exception.detail)
        finally:
            main.TMDB_API_KEY = orig_key

    @patch("main.requests.get")
    def test_tmdb_get_uses_bearer_token_for_v4(self, mock_get):
        orig_key = main.TMDB_API_KEY
        try:
            main.TMDB_API_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIxMjM0NTYifQ.signature"
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {"id": 550, "title": "Fight Club"}
            mock_get.return_value = mock_resp

            data = main.tmdb_get("/movie/550")
            self.assertEqual(data["id"], 550)
            mock_get.assert_called_once()
            _, kwargs = mock_get.call_args
            self.assertEqual(kwargs["headers"]["Authorization"], f"Bearer {main.TMDB_API_KEY}")
        finally:
            main.TMDB_API_KEY = orig_key

    @patch("main.requests.get")
    def test_tmdb_get_uses_api_key_query_param_for_v3(self, mock_get):
        orig_key = main.TMDB_API_KEY
        try:
            main.TMDB_API_KEY = "0123456789abcdef0123456789abcdef"
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {"id": 550, "title": "Fight Club"}
            mock_get.return_value = mock_resp

            data = main.tmdb_get("/movie/550")
            self.assertEqual(data["id"], 550)
            mock_get.assert_called_once()
            _, kwargs = mock_get.call_args
            self.assertEqual(kwargs["params"]["api_key"], "0123456789abcdef0123456789abcdef")
        finally:
            main.TMDB_API_KEY = orig_key

    def test_health_endpoint(self):
        res = main.health()
        self.assertTrue(res["ok"])
        self.assertIn("vixsrc_domain", res)
        self.assertIn("tmdb_configured", res)

    def test_stats_endpoint(self):
        res = main.stats()
        self.assertIn("totalTitles", res)
        self.assertIn("movies", res)
        self.assertIn("series", res)
        self.assertIn("averageScore", res)
        self.assertIn("genreBreakdown", res)
        self.assertIn("weeklyViews", res)


if __name__ == "__main__":
    unittest.main()

