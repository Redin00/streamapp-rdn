import unittest
from unittest.mock import MagicMock, patch
import requests

import main


class TestCacheAndProtection(unittest.TestCase):
    def setUp(self):
        main._cache.clear()
        self.orig_sc = main.SC_DOMAIN
        self.orig_vix = main.VIXSRC_DOMAIN

    def tearDown(self):
        main.configure_domains(self.orig_sc, self.orig_vix)
        main._cache.clear()

    def test_cached_serves_stale_on_producer_failure(self):
        calls = 0

        def flaky_producer():
            nonlocal calls
            calls += 1
            if calls > 1:
                raise requests.exceptions.HTTPError("403 Forbidden")
            return [{"id": 1, "name": "Item 1"}]

        # First call populates cache
        res1 = main.cached("test_key", flaky_producer)
        self.assertEqual(len(res1), 1)

        # Force cache entry to be older than TTL
        main._cache["test_key"] = (0.0, res1)

        # Second call triggers producer, which fails with 403, but returns stale cache
        res2 = main.cached("test_key", flaky_producer)
        self.assertEqual(res2, res1)
        self.assertEqual(calls, 2)

    def test_cached_raises_if_no_stale_cache(self):
        def failing_producer():
            raise RuntimeError("Backend down")

        with self.assertRaises(RuntimeError):
            main.cached("non_existent_key", failing_producer)

    def test_configure_domains_preserves_cache_if_domain_unchanged(self):
        main._cache["my_key"] = (1000000000.0, "value")
        main.configure_domains(main.SC_DOMAIN, "different-vixsrc.to")
        self.assertIn("my_key", main._cache)

    def test_configure_domains_clears_cache_if_domain_changed(self):
        main._cache["my_key"] = (1000000000.0, "value")
        main.configure_domains("brand-new-sc-domain.org", main.VIXSRC_DOMAIN)
        self.assertNotIn("my_key", main._cache)

    @patch("main.requests.get")
    def test_check_domain_redirect_throttle(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.url = f"https://{main.SC_DOMAIN}/"
        mock_resp.text = "<html>StreamingCommunity</html>"
        mock_resp.status_code = 200
        mock_get.return_value = mock_resp

        # First check runs
        res1 = main.check_domain_redirect()
        self.assertTrue(res1["checked"])
        self.assertEqual(mock_get.call_count, 1)

        # Immediate second check should be throttled
        res2 = main.check_domain_redirect()
        self.assertFalse(res2["checked"])
        self.assertTrue(res2.get("cooldown"))
        # requests.get should not have been called again
        self.assertEqual(mock_get.call_count, 1)

        # Third check with force=True should bypass throttle
        res3 = main.check_domain_redirect(force=True)
        self.assertTrue(res3["checked"])
        self.assertEqual(mock_get.call_count, 2)

