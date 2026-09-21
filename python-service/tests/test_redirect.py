import unittest
from unittest.mock import MagicMock, patch
import requests

import main
from db import get_setting, set_setting


class TestDomainRedirect(unittest.TestCase):
    def setUp(self):
        # Save original state
        self.orig_sc_domain = main.SC_DOMAIN
        self.orig_vixsrc_domain = main.VIXSRC_DOMAIN
        # Set a test domain
        set_setting("sc_domain", "streamingcommunity-test.old")
        main.configure_domains("streamingcommunity-test.old", "vixsrc.to")

    def tearDown(self):
        # Restore
        set_setting("sc_domain", self.orig_sc_domain)
        set_setting("vixsrc_domain", self.orig_vixsrc_domain)
        main.configure_domains(self.orig_sc_domain, self.orig_vixsrc_domain)

    @patch("main.requests.get")
    def test_redirect_to_new_valid_domain(self, mock_get):
        # Simulate redirect to a new valid StreamingCommunity domain
        mock_resp = MagicMock()
        mock_resp.url = "https://streamingcommunityz.taxi/"
        mock_resp.text = "<html><head><title>StreamingCommunity</title></head></html>"
        mock_resp.status_code = 200
        mock_get.return_value = mock_resp

        result = main.check_domain_redirect()

        self.assertTrue(result["checked"])
        self.assertTrue(result["redirected"])
        self.assertEqual(result["currentDomain"], "streamingcommunityz.taxi")
        self.assertEqual(main.SC_DOMAIN, "streamingcommunityz.taxi")
        self.assertEqual(get_setting("sc_domain"), "streamingcommunityz.taxi")

    @patch("main.requests.get")
    def test_no_redirect(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.url = "https://streamingcommunity-test.old/"
        mock_resp.text = "<html>StreamingCommunity</html>"
        mock_resp.status_code = 200
        mock_get.return_value = mock_resp

        result = main.check_domain_redirect()

        self.assertTrue(result["checked"])
        self.assertFalse(result["redirected"])
        self.assertEqual(result["currentDomain"], "streamingcommunity-test.old")
        self.assertEqual(main.SC_DOMAIN, "streamingcommunity-test.old")

    @patch("main.requests.get")
    def test_blocks_sinkhole_redirect(self, mock_get):
        # Simulate redirect to an AGCOM or government sinkhole block
        mock_resp = MagicMock()
        mock_resp.url = "http://block.gov.it/passthrough?data=123"
        mock_resp.text = "<html>Sito sottoposto a sequestro preventivo</html>"
        mock_resp.status_code = 200
        mock_get.return_value = mock_resp

        result = main.check_domain_redirect()

        self.assertTrue(result["checked"])
        self.assertFalse(result["redirected"])
        self.assertIn("untrusted or blocked", result.get("error", ""))
        # Domain should NOT be changed
        self.assertEqual(main.SC_DOMAIN, "streamingcommunity-test.old")
        self.assertEqual(get_setting("sc_domain"), "streamingcommunity-test.old")

    @patch("main.requests.get")
    def test_ssl_fallback_to_http(self, mock_get):
        # First call (https) raises SSLError, second call (http) succeeds and redirects
        mock_resp = MagicMock()
        mock_resp.url = "https://streamingcommunity-new.org/"
        mock_resp.text = "<html>data-domain='streamingcommunity.to'</html>"
        mock_resp.status_code = 200

        mock_get.side_effect = [
            requests.exceptions.SSLError("certificate error"),
            mock_resp,
        ]

        result = main.check_domain_redirect()

        self.assertTrue(result["checked"])
        self.assertTrue(result["redirected"])
        self.assertEqual(result["currentDomain"], "streamingcommunity-new.org")
        self.assertEqual(main.SC_DOMAIN, "streamingcommunity-new.org")

    @patch("main.requests.get")
    def test_vixsrc_redirect_to_new_domain(self, mock_get):
        set_setting("vixsrc_domain", "vixsrc-old.to")
        main.configure_domains(main.SC_DOMAIN, "vixsrc-old.to")

        mock_resp = MagicMock()
        mock_resp.url = "https://vixcloud.co/"
        mock_resp.text = "<html>vixsrc player</html>"
        mock_resp.status_code = 200
        mock_get.return_value = mock_resp

        result = main.check_vixsrc_redirect()

        self.assertTrue(result["checked"])
        self.assertTrue(result["redirected"])
        self.assertEqual(result["currentDomain"], "vixcloud.co")
        self.assertEqual(main.VIXSRC_DOMAIN, "vixcloud.co")
        self.assertEqual(get_setting("vixsrc_domain"), "vixcloud.co")

    @patch("main.requests.get")
    def test_vixsrc_blocks_sinkhole(self, mock_get):
        set_setting("vixsrc_domain", "vixsrc-old.to")
        main.configure_domains(main.SC_DOMAIN, "vixsrc-old.to")

        mock_resp = MagicMock()
        mock_resp.url = "http://block.gov.it/notice"
        mock_resp.text = "<html>Blocked</html>"
        mock_resp.status_code = 200
        mock_get.return_value = mock_resp

        result = main.check_vixsrc_redirect()

        self.assertTrue(result["checked"])
        self.assertFalse(result["redirected"])
        self.assertEqual(main.VIXSRC_DOMAIN, "vixsrc-old.to")

    @patch("main.requests.get")
    def test_check_all_domains_redirect(self, mock_get):
        # SC redirects, vixsrc does not
        sc_resp = MagicMock()
        sc_resp.url = "https://streamingcommunityz.taxi/"
        sc_resp.text = "<html>StreamingCommunity</html>"
        sc_resp.status_code = 200

        vix_resp = MagicMock()
        vix_resp.url = "https://vixsrc.to/"
        vix_resp.text = "<html>vixsrc</html>"
        vix_resp.status_code = 200

        mock_get.side_effect = [sc_resp, vix_resp]

        result = main.check_all_domains_redirect()

        self.assertTrue(result["checked"])
        self.assertTrue(result["redirected"])
        self.assertEqual(result["sc"]["currentDomain"], "streamingcommunityz.taxi")
        self.assertEqual(result["vixsrc"]["currentDomain"], "vixsrc.to")


if __name__ == "__main__":
    unittest.main()
