"""Automated security test suite verifying protections against Path Traversal,
SSRF, XSS/HTML injection, Session Token exposure (scoped WS tickets),
Rate Limiting, and HTTP Security Headers.
"""

import os
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main
from auth import create_session, hash_password
from db import clean_snapshot, connect, now, parse_snapshot
from security import (
     create_ws_ticket,
    is_safe_public_hostname,
    rate_limiter,
    resolve_safe_upload_path,
    sanitize_avatar_url,
    sanitize_display_name,
    sanitize_guest_color,
    validate_room_code,
    validate_safe_external_url,
    validate_slug,
    verify_ws_ticket,
)


client = TestClient(main.app)


def _ensure_test_user(name: str = "SecTester", role: str = "member") -> tuple[int, str]:
    with connect() as conn:
        row = conn.execute("SELECT id FROM accounts WHERE name = ?", (name,)).fetchone()
        if row:
            uid = row["id"]
            conn.execute("UPDATE accounts SET role = ? WHERE id = ?", (role, uid))
        else:
            cur = conn.execute(
                "INSERT INTO accounts (name, password_hash, role, color, created_at) VALUES (?, ?, ?, ?, ?)",
                (name, hash_password("SecPass123!"), role, "#10b981", now()),
            )
            uid = cur.lastrowid
    return uid, create_session(uid)


class TestPathTraversalAndUploads:
    """Verify path traversal and symlink attacks are blocked on uploads and static serving."""

    def test_resolve_safe_upload_path_blocks_traversal(self, tmp_path: Path):
        for payload in [
            "../secret.png",
            "../../etc/passwd",
            "..\\..\\windows\\win.ini",
            "1/../../secret.jpg",
            "1.jpg\x00.png",
            "shell.php",
            "script.svg",
            "exploit.html",
            ".hidden.png",
        ]:
            with pytest.raises(Exception):
                resolve_safe_upload_path(tmp_path, payload)

    def test_resolve_safe_upload_path_blocks_symlinks(self, tmp_path: Path):
        outside = tmp_path / "outside_secret.jpg"
        outside.write_bytes(b"secret")
        upload_dir = tmp_path / "uploads"
        upload_dir.mkdir()
        symlink_file = upload_dir / "999.jpg"
        symlink_file.symlink_to(outside)

        with pytest.raises(Exception) as exc_info:
            resolve_safe_upload_path(upload_dir, "999.jpg")
        assert getattr(exc_info.value, "status_code", 403) == 403

    def test_profile_pictures_endpoint_blocks_invalid_filenames(self):
        for bad_name in ["..%2Fmain.py", "main.py", "test.svg", "123.php", "..\\auth.py"]:
            res = client.get(f"/profile-pictures/{bad_name}")
            assert res.status_code in (400, 404)


class TestSSRFProtection:
    """Verify SSRF protections block loopback, RFC1918 private IPs, link-local metadata, and internal hosts."""

    @pytest.mark.parametrize(
        "unsafe_host",
        [
            "localhost",
            "127.0.0.1",
            "127.0.0.53",
            "0.0.0.0",
            "169.254.169.254",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "[::1]",
            "::1",
            "metadata.google.internal",
            "redis.local",
            "db.internal",
            "vixsrc.to:8080",
            "user:pass@vixsrc.to",
            "2130706433",  # decimal IP for 127.0.0.1
        ],
    )
    def test_is_safe_public_hostname_rejects_internal_targets(self, unsafe_host: str):
        assert is_safe_public_hostname(unsafe_host) is False

    def test_is_safe_public_hostname_accepts_valid_domains(self):
        assert is_safe_public_hostname("vixsrc.to") is True
        assert is_safe_public_hostname("vixcloud.co") is True
        assert is_safe_public_hostname("image.tmdb.org") is True

    def test_validate_safe_external_url_blocks_ssrf_and_bad_schemes(self):
        for bad_url in [
            "http://127.0.0.1:8000/health",
            "http://169.254.169.254/latest/meta-data/",
            "https://localhost/admin",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,<script>alert(1)</script>",
            "https://user:pass@example.com/pic.png",
        ]:
            with pytest.raises(ValueError):
                validate_safe_external_url(bad_url)

    def test_admin_settings_domains_rejects_ssrf_targets(self):
        _, admin_token = _ensure_test_user("SecAdmin", role="admin")
        for bad_domain in ["127.0.0.1", "169.254.169.254", "localhost", "192.168.1.1", "internal.local"]:
            res = client.put(
                "/settings/domains",
                json={"vixsrcDomain": bad_domain},
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert res.status_code == 422


class TestXSSAndInputSanitization:
    """Verify XSS and injection payloads are rejected or stripped across accounts, library, and Watch Party."""

    def test_display_name_rejects_html_tags_and_control_chars(self):
        stripped = sanitize_display_name("<script>alert(1)</script>")
        assert "<" not in stripped and ">" not in stripped
        assert sanitize_display_name("User\x00Name") == "UserName"
        with pytest.raises(ValueError):
            sanitize_display_name("<><>\x00\x07")
        assert sanitize_display_name("  Mario Rossi  ") == "Mario Rossi"

    def test_snapshot_sanitizes_html_and_javascript_urls(self):
        raw = {
            "slug": "550-movie-fight-club",
            "name": "<img src=x onerror=alert(1)>Fight Club",
            "posterUrl": "javascript:alert(document.cookie)",
            "backdropUrl": "https://image.tmdb.org/t/p/original/abc.jpg",
            "genres": ["<b>Azione</b>", "Dramma"],
        }
        cleaned_json = clean_snapshot(raw)
        parsed = parse_snapshot(cleaned_json)
        assert "<" not in parsed["name"]
        assert ">" not in parsed["name"]
        assert parsed["posterUrl"] == ""
        assert parsed["backdropUrl"] == "https://image.tmdb.org/t/p/original/abc.jpg"
        assert "<" not in parsed["genres"][0]

    def test_slug_validation_blocks_traversal_and_xss(self):
        for bad_slug in ["../etc/passwd", "550-movie<script>", "slug/with/slash", "slug with spaces"]:
            with pytest.raises(Exception):
                validate_slug(bad_slug)
        assert validate_slug("550-movie-fight-club") == "550-movie-fight-club"

    def test_watch_party_guest_inputs_sanitized(self):
        res = client.post(
            "/party/create",
            json={
                "media": {
                    "slug": "550-movie-fight-club",
                    "tmdbId": 550,
                    "type": "movie",
                    "titleName": "<script>Evil</script>Fight Club",
                },
                "guestId": "guest-xss",
                "guestName": "<svg onload=alert(1)>Hacker",
                "guestColor": "red; background:url(javascript:alert(1))",
                "guestAvatar": "javascript:alert(1)",
            },
        )
        assert res.status_code == 200
        data = res.json()
        member = data["members"][0]
        assert "<" not in member["name"]
        assert member["color"] == "#f59e0b"
        assert member["profilePicture"] is None
        assert "<" not in data["media"]["titleName"]


class TestScopedWebSocketTickets:
    """Verify short-lived HMAC WebSocket tickets work and prevent raw session token exposure."""

    def test_ws_ticket_lifecycle_and_tamper_resistance(self):
        uid, session_token = _ensure_test_user("TicketUser")
        res = client.get("/party/ws-ticket", headers={"Authorization": f"Bearer {session_token}"})
        assert res.status_code == 200
        ticket = res.json()["ticket"]
        assert ticket is not None
        assert ticket.startswith(f"ws.{uid}.")
        assert ticket != session_token

        # Verify valid ticket resolves to user ID
        assert verify_ws_ticket(ticket) == uid

        # Tampered signature or account ID must fail verification
        parts = ticket.split(".")
        tampered_uid = ".".join(["ws", "99999", parts[2], parts[3], parts[4]])
        assert verify_ws_ticket(tampered_uid) is None

        tampered_sig = ".".join(parts[:-1] + ["0" * 64])
        assert verify_ws_ticket(tampered_sig) is None

        # Expired ticket must fail verification
        expired_ticket = create_ws_ticket(uid, now_ms=1000)
        assert verify_ws_ticket(expired_ticket) is None

    def test_websocket_accepts_scoped_ws_ticket(self):
        uid, session_token = _ensure_test_user("WsTicketHost")
        ticket = create_ws_ticket(uid)

        create_res = client.post(
            "/party/create",
            json={"media": {"slug": "550-movie", "tmdbId": 550, "type": "movie"}},
            headers={"Authorization": f"Bearer {session_token}"},
        )
        code = create_res.json()["code"]

        with client.websocket_connect(f"/ws/party/{code}?token={ticket}") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "ROOM_STATE"
            assert msg["yourAccountId"] == uid


class TestRateLimitingAndSecurityHeaders:
    """Verify rate limiting and HTTP security response headers."""

    def test_security_headers_present_and_docs_disabled(self):
        res = client.get("/health")
        assert res.status_code == 200
        assert res.headers.get("X-Content-Type-Options") == "nosniff"
        assert res.headers.get("X-Frame-Options") == "SAMEORIGIN"
        assert res.headers.get("Referrer-Policy") == "strict-origin-when-cross-origin"
        assert "geolocation=()" in (res.headers.get("Permissions-Policy") or "")

        # Auth endpoints must include Cache-Control: no-store
        prof_res = client.get("/auth/profiles")
        assert "no-store" in (prof_res.headers.get("Cache-Control") or "")

        # OpenAPI docs disabled by default
        docs_res = client.get("/docs")
        assert docs_res.status_code == 404

    def test_sliding_window_rate_limiter_enforces_429(self):
        rate_limiter.clear()
        rate_limiter.enabled_in_tests = True
        try:
            for _ in range(5):
                res = client.post("/auth/register", json={"name": "ab", "password": "short"})
                assert res.status_code == 422  # reaches validation before rate limit cap
            # 6th attempt within window must be blocked with 429 Too Many Requests
            res_limited = client.post("/auth/register", json={"name": "ValidUser", "password": "ValidPassword123"})
            assert res_limited.status_code == 429
            assert "Retry-After" in res_limited.headers
        finally:
            rate_limiter.enabled_in_tests = False
            rate_limiter.clear()
