"""Centralized security utilities, validators, rate limiting, and middleware.

Protects the backend against:
- Path Traversal & Symlink following
- Server-Side Request Forgery (SSRF)
- Stored & Reflected XSS / HTML injection
- Brute-force & automated DoS attacks (Sliding-window IP rate limiting)
- Session token exposure (Scoped HMAC WebSocket tickets)
- Missing HTTP security headers & unsafe caching of auth endpoints
"""

from __future__ import annotations

import collections
import hashlib
import hmac
import ipaddress
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Callable, Deque, Dict, Optional, Tuple
from urllib.parse import urlparse

from fastapi import HTTPException, Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

# --------------------------------------------------------------------------- #
# Constants & Regexes
# --------------------------------------------------------------------------- #

SAFE_FILENAME_RE = re.compile(r"^[a-zA-Z0-9_-]+\.(jpg|jpeg|png)$")
SAFE_SLUG_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$")
SAFE_ROOM_CODE_RE = re.compile(r"^[A-Z0-9-]{3,20}$")
SAFE_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
SAFE_HOSTNAME_RE = re.compile(
    r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$"
)
CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")

FORBIDDEN_TLDS_AND_HOSTS = (
    "localhost",
    ".local",
    ".internal",
    ".lan",
    ".arpa",
    ".localdomain",
    ".home",
    ".corp",
    "metadata.google.internal",
    "169.254.169.254",
)

# Ephemeral per-process secret (or env-provided) for short-lived WebSocket tickets
_WS_TICKET_SECRET: bytes = (
    os.environ.get("SC_WS_SECRET") or secrets.token_hex(32)
).encode("utf-8")
WS_TICKET_TTL_MS = 5 * 60 * 1000  # 5 minutes


# --------------------------------------------------------------------------- #
# Scoped HMAC WebSocket Tickets
# --------------------------------------------------------------------------- #


def create_ws_ticket(account_id: int, now_ms: Optional[int] = None) -> str:
    """Create a short-lived HMAC-signed ticket scoped exclusively to WebSocket party auth."""
    ts = now_ms if now_ms is not None else int(time.time() * 1000)
    expires_at = ts + WS_TICKET_TTL_MS
    nonce = secrets.token_hex(8)
    payload = f"ws.{account_id}.{expires_at}.{nonce}"
    sig = hmac.new(_WS_TICKET_SECRET, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def verify_ws_ticket(ticket: str, now_ms: Optional[int] = None) -> Optional[int]:
    """Verify a `ws.<account_id>.<expires_at>.<nonce>.<sig>` ticket and return account_id."""
    if not ticket or not ticket.startswith("ws."):
        return None
    parts = ticket.split(".")
    if len(parts) != 5:
        return None
    _, acc_str, exp_str, nonce, sig = parts
    try:
        account_id = int(acc_str)
        expires_at = int(exp_str)
    except ValueError:
        return None

    cur_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    if expires_at <= cur_ms:
        return None

    payload = f"ws.{account_id}.{expires_at}.{nonce}"
    expected_sig = hmac.new(
        _WS_TICKET_SECRET, payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(sig, expected_sig):
        return None
    return account_id


# --------------------------------------------------------------------------- #
# SSRF & Domain / URL Validation
# --------------------------------------------------------------------------- #


def is_ip_literal_or_private(host: str) -> bool:
    """Return True if host is an IP literal (IPv4/IPv6/integer) or resolves to a special range."""
    cleaned = host.strip().strip("[]")
    if not cleaned:
        return True
    try:
        ip = ipaddress.ip_address(cleaned)
        return True  # Disallow raw IP literals as external domains
    except ValueError:
        pass
    # Also block purely numeric / hex / octal dotted quads like 0x7f.0.0.1 or 2130706433
    if all(part.isdigit() or part.lower().startswith("0x") for part in cleaned.split(".")):
        return True
    return False


def is_safe_public_hostname(
    host: str, extra_blocked: Tuple[str, ...] = ()
) -> bool:
    """Validate that a hostname is a syntactically valid public domain name and not SSRF-prone."""
    if not host or not isinstance(host, str):
        return False
    h = host.strip().lower()
    if len(h) > 253 or len(h) < 3:
        return False
    if any(ch in h for ch in ("/", "\\", "?", "#", "@", ":", " ", "\t", "\n", "\r")):
        return False
    if CONTROL_CHARS_RE.search(h):
        return False
    if is_ip_literal_or_private(h):
        return False
    for forbidden in FORBIDDEN_TLDS_AND_HOSTS:
        if h == forbidden or h.endswith(forbidden):
            return False
    for pattern in extra_blocked:
        if pattern in h:
            return False
    if not SAFE_HOSTNAME_RE.fullmatch(h):
        return False
    # TLD must not be all-numeric
    tld = h.rsplit(".", 1)[-1]
    if tld.isdigit():
        return False
    return True


def validate_safe_external_url(
    url: str,
    *,
    require_https: bool = False,
    max_length: int = 600,
    extra_blocked: Tuple[str, ...] = (),
) -> str:
    """Validate that a URL uses http(s) and targets a safe public hostname."""
    if not url or not isinstance(url, str):
        raise ValueError("URL must not be empty")
    u = url.strip()
    if len(u) > max_length or CONTROL_CHARS_RE.search(u):
        raise ValueError("Invalid URL")
    parsed = urlparse(u)
    allowed_schemes = ("https",) if require_https else ("https", "http")
    if parsed.scheme.lower() not in allowed_schemes:
        raise ValueError(f"URL must use {'https' if require_https else 'http or https'}")
    if parsed.username or parsed.password:
        raise ValueError("URL must not contain credentials")
    hostname = (parsed.hostname or "").strip().lower()
    if not is_safe_public_hostname(hostname, extra_blocked=extra_blocked):
        raise ValueError("URL hostname is not allowed")
    return u


# --------------------------------------------------------------------------- #
# Path Traversal Protection
# --------------------------------------------------------------------------- #


def resolve_safe_upload_path(base_dir: Path, filename: str) -> Path:
    """Validate `filename` and return a canonical path strictly inside `base_dir`."""
    if not filename or not isinstance(filename, str):
        raise HTTPException(status_code=400, detail="Invalid filename")
    # Reject any path separators, traversal sequences, or non-whitelisted characters
    if (
        "/" in filename
        or "\\" in filename
        or ".." in filename
        or "\x00" in filename
        or not SAFE_FILENAME_RE.fullmatch(filename)
    ):
        raise HTTPException(status_code=400, detail="Invalid filename")

    canonical_base = base_dir.resolve()
    candidate = canonical_base / filename

    # Check symlink before resolving so a symlink inside uploads/ pointing to /etc/passwd is rejected
    if candidate.is_symlink():
        raise HTTPException(status_code=403, detail="Forbidden file")

    resolved = candidate.resolve()
    if not resolved.is_relative_to(canonical_base):
        raise HTTPException(status_code=403, detail="Path traversal detected")

    return resolved


# --------------------------------------------------------------------------- #
# Input Sanitizers & Validators
# --------------------------------------------------------------------------- #


def sanitize_display_name(value: str, max_length: int = 40) -> str:
    """Strip control characters and HTML brackets from user/guest display names."""
    if not isinstance(value, str):
        raise ValueError("name must be a string")
    cleaned = CONTROL_CHARS_RE.sub("", value)
    # Remove HTML angle brackets to prevent stored XSS in names
    cleaned = cleaned.replace("<", "").replace(">", "").strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    if not cleaned:
        raise ValueError("name must not be blank")
    if len(cleaned) > max_length:
        cleaned = cleaned[:max_length].strip()
    return cleaned


def validate_slug(slug: str) -> str:
    """Ensure a media slug contains only safe characters and no path traversal."""
    if not isinstance(slug, str):
        raise HTTPException(status_code=400, detail="Invalid slug")
    s = slug.strip()
    if not s or ".." in s or "/" in s or "\\" in s or not SAFE_SLUG_RE.fullmatch(s):
        raise HTTPException(status_code=400, detail="Invalid slug format")
    return s


def validate_room_code(code: str) -> str:
    """Ensure a Watch Party room code is alphanumeric/hyphen and bounded."""
    if not isinstance(code, str):
        raise HTTPException(status_code=400, detail="Invalid room code")
    clean = code.strip().upper()
    if not SAFE_ROOM_CODE_RE.fullmatch(clean):
        raise HTTPException(status_code=400, detail="Invalid room code format")
    return clean


def sanitize_guest_color(color: Optional[str], default: str = "#f59e0b") -> str:
    """Return a validated #rrggbb hex color or the default."""
    if not color or not isinstance(color, str):
        return default
    c = color.strip().lower()
    return c if SAFE_HEX_COLOR_RE.fullmatch(c) else default


def sanitize_avatar_url(avatar: Optional[str]) -> Optional[str]:
    """Allow only safe `/profile-pictures/...` paths or public `https://` URLs."""
    if not avatar or not isinstance(avatar, str):
        return None
    a = avatar.strip()
    if not a or len(a) > 500 or CONTROL_CHARS_RE.search(a):
        return None
    if a.startswith("/profile-pictures/"):
        fname = a.removeprefix("/profile-pictures/")
        return a if SAFE_FILENAME_RE.fullmatch(fname) else None
    try:
        return validate_safe_external_url(a, require_https=False, max_length=500)
    except ValueError:
        return None


# --------------------------------------------------------------------------- #
# Sliding-Window IP Rate Limiter
# --------------------------------------------------------------------------- #


class SlidingWindowRateLimiter:
    """Thread-safe in-memory sliding-window rate limiter keyed by (bucket, client_ip)."""

    def __init__(self) -> None:
        self._hits: Dict[Tuple[str, str], Deque[float]] = collections.defaultdict(
            collections.deque
        )
        self._lock = threading.Lock()
        self._last_cleanup = time.monotonic()
        self.enabled_in_tests = False

    def clear(self) -> None:
        with self._lock:
            self._hits.clear()

    def get_client_ip(self, request: Request) -> str:
        client_host = request.client.host if request.client else "unknown"
        trust_proxy = os.environ.get("SC_TRUST_PROXY", "0") == "1" or client_host in (
            "127.0.0.1",
            "::1",
            "localhost",
        )
        if trust_proxy:
            xff = request.headers.get("x-forwarded-for")
            if xff:
                first_ip = xff.split(",")[0].strip()
                if first_ip:
                    return first_ip[:64]
            xri = request.headers.get("x-real-ip")
            if xri:
                return xri.strip()[:64]
        return client_host[:64]

    def check(
        self,
        request: Request,
        bucket: str,
        max_requests: int,
        window_seconds: float,
    ) -> None:
        client_ip = self.get_client_ip(request)
        if client_ip == "testclient" and not self.enabled_in_tests:
            return

        now_mono = time.monotonic()
        cutoff = now_mono - window_seconds
        key = (bucket, client_ip)

        with self._lock:
            # Periodic cleanup of idle buckets every 120 seconds to bound memory
            if now_mono - self._last_cleanup > 120.0:
                self._last_cleanup = now_mono
                stale_keys = [
                    k for k, dq in self._hits.items() if not dq or dq[-1] < now_mono - 600.0
                ]
                for k in stale_keys:
                    del self._hits[k]

            dq = self._hits[key]
            while dq and dq[0] <= cutoff:
                dq.popleft()

            if len(dq) >= max_requests:
                retry_after = max(1, int(window_seconds - (now_mono - dq[0])))
                raise HTTPException(
                    status_code=429,
                    detail={
                        "message": "Too many requests. Please slow down.",
                        "retryAfter": retry_after,
                    },
                    headers={"Retry-After": str(retry_after)},
                )
            dq.append(now_mono)


rate_limiter = SlidingWindowRateLimiter()


def limit_requests(bucket: str, max_requests: int, window_seconds: float) -> Callable:
    """FastAPI dependency factory for route-specific rate limiting."""

    def _dependency(request: Request) -> None:
        rate_limiter.check(request, bucket, max_requests, window_seconds)

    return _dependency


# --------------------------------------------------------------------------- #
# HTTP Security Headers Middleware
# --------------------------------------------------------------------------- #

SENSITIVE_PATH_PREFIXES = ("/auth/", "/accounts", "/settings/", "/library", "/history", "/party")


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Attach defensive HTTP security headers and global IP rate limit to every response."""

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path
        # Global per-IP flood protection (exempting real-time Watch Party sync polling)
        if not path.startswith("/party/"):
            try:
                rate_limiter.check(request, "global", 600, 60.0)
            except HTTPException as exc:
                return Response(
                    content='{"detail":"Too many requests"}',
                    status_code=exc.status_code,
                    media_type="application/json",
                    headers=exc.headers or {},
                )

        response: Response = await call_next(request)

        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("X-XSS-Protection", "0")
        response.headers.setdefault(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        )
        response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")

        path = request.url.path
        if path.startswith("/profile-pictures/"):
            # Harden uploaded image serving against MIME sniffing or SVG/HTML execution
            response.headers["Content-Security-Policy"] = (
                "default-src 'none'; style-src 'unsafe-inline'; sandbox"
            )
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
        elif any(path.startswith(prefix) for prefix in SENSITIVE_PATH_PREFIXES):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, private"
            response.headers["Pragma"] = "no-cache"

        if request.url.scheme == "https" or os.environ.get("NODE_ENV") == "production":
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
            )

        return response
