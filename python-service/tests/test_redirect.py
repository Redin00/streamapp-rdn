import unittest
from unittest.mock import MagicMock, patch
import requests

import main
from db import get_setting, set_setting


class TestDomainRedirect(unittest.TestCase):
    def setUp(self):
        self.orig_vixsrc_domain = main.VIXSRC_DOMAIN
        set_setting("vixsrc_domain", "vixsrc-test.old")
        main.configure_domains("vixsrc-test.old")

    def tearDown(self):
        set_setting("vixsrc_domain", self.orig_vixsrc_domain)
        main.configure_domains(self.orig_vixsrc_domain)

    @patch("main.requests.get")
    def test_vixsrc_redirect_to_new_domain(self, mock_get):
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
    def test_vixsrc_no_redirect(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.url = "https://vixsrc-test.old/"
        mock_resp.text = "<html>vixsrc player</html>"
        mock_resp.status_code = 200
        mock_get.return_value = mock_resp

        result = main.check_vixsrc_redirect()

        self.assertTrue(result["checked"])
        self.assertFalse(result["redirected"])
        self.assertEqual(result["currentDomain"], "vixsrc-test.old")
        self.assertEqual(main.VIXSRC_DOMAIN, "vixsrc-test.old")

    @patch("main.requests.get")
    def test_vixsrc_blocks_sinkhole(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.url = "http://block.gov.it/notice"
        mock_resp.text = "<html>Blocked</html>"
        mock_resp.status_code = 200
        mock_get.return_value = mock_resp

        result = main.check_vixsrc_redirect()

        self.assertTrue(result["checked"])
        self.assertFalse(result["redirected"])
        self.assertEqual(main.VIXSRC_DOMAIN, "vixsrc-test.old")

    @patch("main.requests.get")
    def test_check_all_domains_redirect(self, mock_get):
        vix_resp = MagicMock()
        vix_resp.url = "https://vixcloud.to/"
        vix_resp.text = "<html>vixsrc player</html>"
        vix_resp.status_code = 200
        mock_get.return_value = vix_resp

        result = main.check_all_domains_redirect(force=True)

        self.assertTrue(result["checked"])
        self.assertTrue(result["redirected"])
        self.assertEqual(result["vixsrc"]["currentDomain"], "vixcloud.to")
        self.assertEqual(result["currentDomain"], "vixcloud.to")


if __name__ == "__main__":
    unittest.main()
