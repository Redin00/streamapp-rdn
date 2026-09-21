import unittest
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

import main
from main import app, clean_embed_html


SAMPLE_EMBED_HTML = """<!DOCTYPE html>
<html>
<head>
    <script defer data-domain="vixcloud.co" src="https://analytics.vixcloud.co/js/script.js"></script>
    <meta name="robots" content="none">
    <title>170060</title>
    <script src="/jwplayer-8.36.4/jwplayer.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400&display=swap" rel="stylesheet">
    <script defer src="https://vixsrc.to/build/assets/embed-aWe65dAP.js"></script>
    <link rel="stylesheet" href="https://vixsrc.to/build/assets/skin-embed-jmVRxJFk.css">
    <script defer src="https://vixsrc.to/build/assets/vixsrc-W417G9ts.js"></script>
    <link rel="stylesheet" href="https://vixsrc.to/build/assets/skin-vixsrc-DKeLqJv0.css">
</head>
<body>
    <div id="player"></div>
    <script>
        window.video = { id: '170060', filename: '' };
        window.streams = [{"name":"Server1","active":true,"url":"https://vixsrc.to/playlist/170060"}];
        window.masterPlaylist = { url: 'https://vixsrc.to/playlist/170060', params: {'expires':'123'} };
    </script>
    <script>(function(s){s.dataset.zone='10874703',s.src='https://spbgc.com/tag.min.js'})([document.documentElement, document.body].filter(Boolean).pop().appendChild(document.createElement('script')))</script>
    <script>
        window.addEventListener("DOMContentLoaded",(()=>{function e(){console.log("Sandboxed iframe detected"),document.body.innerHTML='<div style="display:flex;justify-content:center;align-items:center;height:100vh;"><h1>Please Disable Sandbox</h1></div>'}!function(){if(window.self!==window.top){try{if(window.frameElement?.hasAttribute("sandbox"))return e(),!0}catch(e){}try{document.domain=document.domain}catch(t){if(t.toString().toLowerCase().includes("sandbox"))return e(),!0}try{if(!navigator.plugins.namedItem("Chrome PDF Viewer"))return!1;const t=document.createElement("object");t.data="data:application/pdf;base64,aG1t",t.style.cssText="position:absolute;top:-500px;left:-500px;visibility:hidden;",t.onerror=()=>(e(),!0),t.onload=()=>{t.remove()},document.body.appendChild(t)}catch(e){}}}()}));
    </script>
    <script type="text/javascript">
        var minimalUserResponseInMiliseconds=0xde;function check(){debugger;setTimeout(check,0x6f);}check();
    </script>
</body>
</html>
"""


class TestCleanEmbed(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_clean_embed_html_strips_ads_and_protections(self):
        cleaned = clean_embed_html(SAMPLE_EMBED_HTML, "vixsrc.to")

        # 1. Ad scripts must be removed (check for the specific injected snippet, not domain name
        #    since the blocker script itself lists "spbgc.com" in its _adDomains array)
        self.assertNotIn("s.dataset.zone=", cleaned)          # spbgc ad loader removed
        self.assertNotIn("10874703", cleaned)                  # ad tag id removed
        self.assertNotIn("tag.min.js", cleaned)               # ad script src removed

        # 2. Anti-sandbox checks must be removed
        self.assertNotIn("Please Disable Sandbox", cleaned)
        self.assertNotIn("Sandboxed iframe detected", cleaned)

        # 3. Anti-debugger checks must be removed
        self.assertNotIn("minimalUserResponseInMiliseconds", cleaned)
        self.assertNotIn("debugger;", cleaned)

        # 4. Essential player scripts and markup must be preserved
        self.assertIn("/jwplayer-8.36.4/jwplayer.js", cleaned)
        self.assertIn("vixsrc-W417G9ts.js", cleaned)
        self.assertIn("window.video", cleaned)
        self.assertIn("window.streams", cleaned)
        self.assertIn("window.masterPlaylist", cleaned)

        # 5. Base tag must be injected
        self.assertIn('<base href="https://vixsrc.to/">', cleaned)

        # 6. Blocker script must be injected with all key guards
        self.assertIn("[AdBlock]", cleaned)
        self.assertIn("window.open =", cleaned)
        self.assertIn("MutationObserver", cleaned)
        self.assertIn("makeLocProxy", cleaned)   # top/parent location blocker
        self.assertIn("_clickTs", cleaned)       # mousedown-based click guard

    @patch("main._fetch_embed_page")
    def test_clean_embed_endpoint_success(self, mock_fetch):
        mock_fetch.return_value = (SAMPLE_EMBED_HTML, "vixsrc.to")

        res = self.client.get("/clean-embed?tmdb=550&type=movie")
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/html", res.headers["content-type"])
        # Verify ad script snippet is gone, not just the domain name
        self.assertNotIn("s.dataset.zone=", res.text)    # ad tag removed
        self.assertNotIn("Please Disable Sandbox", res.text)
        self.assertIn("jwplayer", res.text)
        self.assertIn("[AdBlock]", res.text)              # blocker injected

    @patch("main._fetch_embed_page")
    def test_clean_embed_endpoint_not_found(self, mock_fetch):
        mock_fetch.return_value = None

        res = self.client.get("/clean-embed?tmdb=9999999&type=movie")
        self.assertEqual(res.status_code, 404)

    @patch("main._fetch_embed_page")
    def test_clean_embed_endpoint_falls_back_on_error(self, mock_fetch):
        mock_fetch.side_effect = RuntimeError("playback host returned 403")

        res = self.client.get("/clean-embed?tmdb=550&type=movie&startAt=120", follow_redirects=False)
        self.assertEqual(res.status_code, 307)
        self.assertIn("location", res.headers)
        self.assertEqual(res.headers["location"], "https://vixsrc.to/movie/550?startAt=120")

    def test_player_endpoint_includes_clean_embed(self):
        res = self.client.get("/player")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["provider"], "vixsrc")
        self.assertTrue(data.get("cleanEmbed"))


if __name__ == "__main__":
    unittest.main()

