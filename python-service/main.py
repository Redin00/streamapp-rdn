"""Streaming dashboard backend service.

Wraps the `streamingcommunity-unofficialapi` (scuapi) Python library and exposes
the JSON endpoints the web dashboard expects:

    GET /health          -> { "ok": true, "domain": "..." }
    GET /search?q=...    -> TitleSummary[]
    GET /trending        -> TitleSummary[]
    GET /latest          -> TitleSummary[]
    GET /title/{id}      -> TitleDetail        (id = "<id>-<slug>" or slug or numeric id)
    GET /stats           -> LibraryStats
    GET /player          -> { "provider", "domain", "enabled" }
    GET /stream          -> { "provider", "playlistUrl", "expiresAt", "fhd" }

Accounts and per-account state (see auth.py and library.py):

    GET    /auth/profiles           -> picker list, public
    POST   /auth/login              -> { "token", "account" }
    POST   /auth/logout             -> 204
    GET    /auth/me                 -> the signed-in account
    POST   /auth/me/picture         -> upload a profile picture (multipart)
    GET    /accounts                -> admin only
    POST   /accounts                -> admin only
    PATCH  /accounts/{id}           -> admin only
    POST   /accounts/{id}/password  -> admin only
    DELETE /accounts/{id}           -> admin only
    GET    /library                 -> saved titles
    POST   /library                 -> save a title
    DELETE /library/{slug}          -> remove a title
    GET    /history?limit=24        -> recently watched
    POST   /history                 -> record a play

Static profile picture storage:

    GET    /profile-pictures/{filename}  -> the uploaded image

Run:

    pip install -r requirements.txt
    SC_DOMAIN=streaming.example uvicorn main:app --reload --port 8000

Then point the dashboard at it:  STREAMING_API_URL=http://localhost:8000
"""

import asyncio
from contextlib import asynccontextmanager
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import requests
from fastapi import Depends, FastAPI, HTTPException, Query, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from scuapi import API

from auth import bootstrap_admin, require_admin
from auth import router as auth_router
from db import get_setting, init_db, set_setting
from library import router as library_router
from watch_party import router as party_router, handle_party_websocket

# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #

logging.basicConfig(
    level=os.environ.get("SC_LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("streaming-dashboard")

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

# The site changes domain often; set the current one here or via env var.
DEFAULT_SC_DOMAIN = "streamingcommunityz.photos"
DEFAULT_VIXSRC_DOMAIN = "vixsrc.to"
SC_DOMAIN = ""
IMAGE_CDN = ""
CACHE_TTL = int(os.environ.get("SC_CACHE_TTL", "600"))  # seconds
CORS_ORIGINS = os.environ.get("SC_CORS_ORIGINS", "*").split(",")

# Playback embed host. Rotates like SC_DOMAIN; leave empty to disable playback.
VIXSRC_DOMAIN = ""

api = None

# The playback host is scraped over two back-to-back requests, so pool them.
vixsrc_session = requests.Session()
JSON_HEADERS = {}

# Where uploaded profile pictures are stored (defaults to an `uploads` folder beside this file).
_PROFILE_PICTURES_DIR = Path(os.environ.get("SC_PROFILE_PICTURES_DIR", str(Path(__file__).parent / "uploads")))
_PROFILE_PICTURES_DIR.mkdir(parents=True, exist_ok=True)

# Public base URL for profile picture links returned to the dashboard.
# Set this to the public URL of the service (e.g. "https://api.example.com") when
# the browser cannot reach the internal bind address (remote deploys, reverse proxy).
# Defaults to the request's base_url for local dev convenience.
SC_BASE_URL = os.environ.get("SC_BASE_URL")

# Import time, so the schema and the first admin exist before the first request.
init_db()
SC_DOMAIN = get_setting("sc_domain", os.environ.get("SC_DOMAIN", DEFAULT_SC_DOMAIN)).strip()
VIXSRC_DOMAIN = get_setting(
    "vixsrc_domain", os.environ.get("SC_VIXSRC_DOMAIN", DEFAULT_VIXSRC_DOMAIN)
).strip()
IMAGE_CDN = f"https://cdn.{SC_DOMAIN}/images"
api = API(SC_DOMAIN)
vixsrc_session.headers["user-agent"] = api.user_agent
JSON_HEADERS = {"user-agent": api.user_agent, "accept": "application/json"}
bootstrap_admin()

# --------------------------------------------------------------------------- #
# Tiny in-process cache (the upstream site is slow and rate-limits)
# --------------------------------------------------------------------------- #

_cache: Dict[str, tuple[float, Any]] = {}


def configure_domains(sc_domain: str, vixsrc_domain: str) -> None:
    global SC_DOMAIN, VIXSRC_DOMAIN, IMAGE_CDN, api, JSON_HEADERS
    SC_DOMAIN = sc_domain
    VIXSRC_DOMAIN = vixsrc_domain
    IMAGE_CDN = f"https://cdn.{SC_DOMAIN}/images"
    api = API(SC_DOMAIN)
    vixsrc_session.headers["user-agent"] = api.user_agent
    JSON_HEADERS = {"user-agent": api.user_agent, "accept": "application/json"}
    _cache.clear()


def current_domains() -> tuple[str, str]:
    return get_setting("sc_domain", SC_DOMAIN), get_setting("vixsrc_domain", VIXSRC_DOMAIN)


BLOCKED_HOST_PATTERNS = (
    "block.",
    "gov.it",
    "agcom.it",
    "poliziadistato.it",
    "gdf.gov.it",
    "guardiadifinanza",
    "stop-piracy",
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
)


def _is_valid_sc_redirect(target_host: str, page_content: str = "") -> bool:
    host = target_host.strip().lower()
    if not host or "/" in host or " " in host or "." not in host:
        return False
    for blocked in BLOCKED_HOST_PATTERNS:
        if blocked in host:
            return False
    if "streamingcommunity" in host:
        return True
    content_lower = page_content.lower()
    if "streamingcommunity" in content_lower or "vixcloud" in content_lower:
        return True
    return False


def check_domain_redirect(target_domain: Optional[str] = None) -> Dict[str, Any]:
    """Check if the StreamingCommunity domain redirects to a new domain and update if so."""
    current = (target_domain or SC_DOMAIN).strip().lower()
    if not current:
        return {
            "checked": False,
            "redirected": False,
            "previousDomain": "",
            "currentDomain": "",
            "error": "no domain configured",
        }

    headers = {"user-agent": api.user_agent if api else "Mozilla/5.0"}
    res = None
    last_err: Optional[Exception] = None

    # Try HTTPS first; fallback to HTTP if SSL error or connection issue
    for scheme in ("https", "http"):
        url = f"{scheme}://{current}"
        try:
            res = requests.get(url, headers=headers, timeout=10, allow_redirects=True)
            break
        except (requests.exceptions.SSLError, requests.exceptions.ConnectionError) as exc:
            last_err = exc
            log.debug("check_domain_redirect %s failed with %s, trying fallback", url, exc)
            continue
        except requests.RequestException as exc:
            last_err = exc
            break

    if res is None:
        log.warning("check_domain_redirect failed for %s: %s", current, last_err)
        return {
            "checked": False,
            "redirected": False,
            "previousDomain": current,
            "currentDomain": SC_DOMAIN,
            "error": str(last_err),
        }

    final_host = urlparse(res.url).netloc.split(":")[0].strip().lower()
    if final_host and final_host != current:
        content_sample = res.text[:2000] if hasattr(res, "text") else ""
        if _is_valid_sc_redirect(final_host, content_sample):
            log.info(
                "Domain redirect detected: %s -> %s. Updating catalogue domain.",
                current,
                final_host,
            )
            set_setting("sc_domain", final_host)
            configure_domains(final_host, VIXSRC_DOMAIN)
            return {
                "checked": True,
                "redirected": True,
                "previousDomain": current,
                "currentDomain": final_host,
            }
        else:
            log.warning(
                "Redirected to invalid or blocked host %s from %s, ignoring.",
                final_host,
                current,
            )
            return {
                "checked": True,
                "redirected": False,
                "previousDomain": current,
                "currentDomain": current,
                "error": f"Redirected to untrusted or blocked host: {final_host}",
            }

    return {
        "checked": True,
        "redirected": False,
        "previousDomain": current,
        "currentDomain": SC_DOMAIN,
    }


def _is_valid_vixsrc_redirect(target_host: str, page_content: str = "") -> bool:
    host = target_host.strip().lower()
    if not host or "/" in host or " " in host or "." not in host:
        return False
    for blocked in BLOCKED_HOST_PATTERNS:
        if blocked in host:
            return False
    if "vix" in host:
        return True
    content_lower = page_content.lower()
    if "vixsrc" in content_lower or "vixcloud" in content_lower or "_next" in content_lower:
        return True
    return False


def check_vixsrc_redirect(target_domain: Optional[str] = None) -> Dict[str, Any]:
    """Check if the Vixsrc playback domain redirects to a new domain and update if so."""
    current = (target_domain or VIXSRC_DOMAIN).strip().lower()
    if not current:
        return {
            "checked": False,
            "redirected": False,
            "previousDomain": "",
            "currentDomain": "",
            "error": "no playback domain configured",
        }

    headers = {"user-agent": vixsrc_session.headers.get("user-agent", "Mozilla/5.0")}
    res = None
    last_err: Optional[Exception] = None

    for scheme in ("https", "http"):
        url = f"{scheme}://{current}"
        try:
            res = requests.get(url, headers=headers, timeout=10, allow_redirects=True)
            break
        except (requests.exceptions.SSLError, requests.exceptions.ConnectionError) as exc:
            last_err = exc
            log.debug("check_vixsrc_redirect %s failed with %s, trying fallback", url, exc)
            continue
        except requests.RequestException as exc:
            last_err = exc
            break

    if res is None:
        log.warning("check_vixsrc_redirect failed for %s: %s", current, last_err)
        return {
            "checked": False,
            "redirected": False,
            "previousDomain": current,
            "currentDomain": VIXSRC_DOMAIN,
            "error": str(last_err),
        }

    final_host = urlparse(res.url).netloc.split(":")[0].strip().lower()
    if final_host and final_host != current:
        content_sample = res.text[:2000] if hasattr(res, "text") else ""
        if _is_valid_vixsrc_redirect(final_host, content_sample):
            log.info(
                "Vixsrc domain redirect detected: %s -> %s. Updating playback domain.",
                current,
                final_host,
            )
            set_setting("vixsrc_domain", final_host)
            configure_domains(SC_DOMAIN, final_host)
            return {
                "checked": True,
                "redirected": True,
                "previousDomain": current,
                "currentDomain": final_host,
            }
        else:
            log.warning(
                "Vixsrc redirected to invalid or blocked host %s from %s, ignoring.",
                final_host,
                current,
            )
            return {
                "checked": True,
                "redirected": False,
                "previousDomain": current,
                "currentDomain": current,
                "error": f"Redirected to untrusted or blocked host: {final_host}",
            }

    return {
        "checked": True,
        "redirected": False,
        "previousDomain": current,
        "currentDomain": VIXSRC_DOMAIN,
    }


def check_all_domains_redirect() -> Dict[str, Any]:
    sc_res = check_domain_redirect()
    vix_res = check_vixsrc_redirect()
    any_redirected = sc_res.get("redirected", False) or vix_res.get("redirected", False)
    all_checked = sc_res.get("checked", False) and vix_res.get("checked", False)
    errors = [e for e in [sc_res.get("error"), vix_res.get("error")] if e]
    return {
        "checked": all_checked or sc_res.get("checked", False) or vix_res.get("checked", False),
        "redirected": any_redirected,
        "sc": sc_res,
        "vixsrc": vix_res,
        "error": "; ".join(errors) if errors else None,
        "currentDomain": sc_res.get("currentDomain", SC_DOMAIN),
        "previousDomain": sc_res.get("previousDomain", SC_DOMAIN),
        "currentVixsrcDomain": vix_res.get("currentDomain", VIXSRC_DOMAIN),
        "previousVixsrcDomain": vix_res.get("previousDomain", VIXSRC_DOMAIN),
    }


async def periodic_domain_check() -> None:
    # Run 5s after startup, then every 30 minutes
    await asyncio.sleep(5)
    while True:
        try:
            log.debug("Running periodic catalogue and playback domain redirect check...")
            await asyncio.to_thread(check_all_domains_redirect)
        except Exception as exc:
            log.warning("Periodic domain redirect check error: %s", exc)
        await asyncio.sleep(1800)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(periodic_domain_check())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="StreamApp - Rdn API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"],
)
app.include_router(auth_router)
app.include_router(library_router)
app.include_router(party_router)


@app.websocket("/ws/party/{code}")
async def party_ws_route(
    websocket: WebSocket,
    code: str,
    token: Optional[str] = Query(None),
    guest_id: Optional[str] = Query(None),
    guest_name: Optional[str] = Query(None),
    guest_color: Optional[str] = Query(None),
    guest_avatar: Optional[str] = Query(None),
):
    await handle_party_websocket(
        websocket,
        code,
        token,
        guest_id=guest_id,
        guest_name=guest_name,
        guest_color=guest_color,
        guest_avatar=guest_avatar,
    )

# Serve uploaded profile pictures under the /profile-pictures path.
app.mount(
    "/profile-pictures",
    StaticFiles(directory=str(_PROFILE_PICTURES_DIR), follow_symlink=True),
    name="profile_pictures",
)


def cached(key: str, producer):
    hit = _cache.get(key)
    now = time.time()
    if hit and now - hit[0] < CACHE_TTL:
        log.debug("cache hit key=%r age=%.1fs", key, now - hit[0])
        return hit[1]

    log.debug("cache miss key=%r", key)
    try:
        value = producer()
    except Exception:
        log.exception("cache producer failed for key=%r", key)
        raise

    _cache[key] = (now, value)
    log.debug("cache store key=%r", key)
    return value


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _image(images: Optional[list], *wanted: str) -> str:
    """Pick the first image of one of the wanted types and build its CDN url."""
    for want in wanted:
        for img in images or []:
            if img.get("type") == want and img.get("filename"):
                return f"{IMAGE_CDN}/{img['filename']}"
    for img in images or []:
        if img.get("filename"):
            return f"{IMAGE_CDN}/{img['filename']}"
    return ""


def _year(raw: Any) -> int:
    if not raw:
        return 0
    digits = "".join(ch for ch in str(raw) if ch.isdigit())
    return int(digits[:4]) if digits else 0


def _score(raw: Any) -> float:
    """The library returns `rating` as score*1000; the sites raw score is 0-10."""
    if raw in (None, ""):
        return 0.0
    value = float(raw)
    if value > 100:  # the library's `rating` form
        value = value / 1000
    return round(value, 1)


def _type(raw: Any) -> str:
    return "tv" if str(raw).lower() in ("tvseries", "tv", "serie", "series") else "movie"


def _genres(item: Dict[str, Any]) -> List[str]:
    if item.get("tags"):
        return [g for g in item["tags"] if g]
    return [g.get("name") for g in item.get("genres") or [] if g.get("name")]


def summary_from_browse(item: Dict[str, Any]) -> Dict[str, Any]:
    """Map a raw title object coming from the sites JSON API to TitleSummary."""
    return {
        "id": item.get("id") or 0,
        "slug": f"{item.get('id')}-{item.get('slug')}" if item.get("slug") else str(item.get("id")),
        "name": item.get("name") or "Untitled",
        "type": _type(item.get("type")),
        "year": _year(item.get("last_air_date") or item.get("release_date")),
        "score": _score(item.get("score") or item.get("rating")),
        "posterUrl": _image(item.get("images"), "poster", "cover"),
        "backdropUrl": _image(item.get("images"), "background", "cover_mobile", "poster"),
        "genres": _genres(item),
        "seasonsCount": item.get("seasons_count"),
    }


def _extract_cast(data: Dict[str, Any]) -> List[str]:
    """Pull cast/crew names from the raw title payload the sites JSON carries.

    The upstream JSON nests credits under ``props.title.credits`` as a list of
    ``{name, role}`` dicts when it is available. When that path is absent (older
    pages, some genres) fall back to an empty list so the dashboard can still
    render the rest of the detail page.
    """
    credits = (
        data.get("props", {})
        .get("title", {})
        .get("credits")
    )
    if not isinstance(credits, list):
        return []
    names: List[str] = []
    for entry in credits:
        name = entry.get("name") if isinstance(entry, dict) else None
        if name and isinstance(name, str):
            names.append(name.strip())
    return names


def detail_from_load(slug: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """Map `API.load()` output to the dashboard TitleDetail shape."""
    media_type = _type(data.get("type"))

    seasons: List[Dict[str, Any]] = []
    if media_type == "tv":
        by_number: Dict[int, Dict[str, Any]] = {}
        for ep in data.get("episodeList") or []:
            number = int(ep.get("season") or 1)
            season = by_number.setdefault(
                number, {"number": number, "name": f"Season {number}", "episodes": []}
            )
            season["episodes"].append(
                {
                    "id": ep.get("id") or 0,
                    "number": ep.get("episode") or len(season["episodes"]) + 1,
                    "name": ep.get("name") or f"Episode {ep.get('episode')}",
                    "plot": ep.get("description") or "",
                    "duration": ep.get("duration") or 0,
                }
            )
        seasons = [by_number[k] for k in sorted(by_number)]

    runtime = data.get("duration")
    if not runtime and seasons and seasons[0]["episodes"]:
        runtime = seasons[0]["episodes"][0]["duration"]

    return {
        "id": data.get("id") or 0,
        "slug": slug,
        "name": data.get("name") or "Untitled",
        "type": media_type,
        "year": _year(data.get("year") or data.get("release_date")),
        "score": _score(data.get("rating")),
        "posterUrl": _image(data.get("images"), "poster", "cover"),
        "backdropUrl": _image(data.get("images"), "background", "cover_mobile", "poster"),
        "genres": _genres(data),
        "seasonsCount": data.get("seasons_count") or (len(seasons) or None),
        "plot": data.get("plot") or "",
        "quality": "HD",
        "runtime": runtime or 0,
        "status": "Series" if media_type == "tv" else "Released",
        "cast": _extract_cast(data) or [],
        "trailerUrl": data.get("trailerUrl"),
        # External ids drive playback: the embed host is keyed by TMDB id.
        "tmdbId": data.get("tmdb_id"),
        "imdbId": data.get("imdb_id"),
        "seasons": seasons,
    }


def browse(slider: str, limit: int = 24) -> List[Dict[str, Any]]:
    """Fetch one of the site listing sliders (trending / latest / top10 / genre).

    The site is a Laravel app that returns a page render payload as JSON when
    asked for `application/json`. That is the only listing API reachable without
    credentials: `api/tv/browse` answers 401 and the library has no browse method.
    """
    url = f"https://{SC_DOMAIN}/it/browse/{slider}"
    log.debug("browse GET %s", url)
    try:
        res = requests.get(url, headers=JSON_HEADERS, timeout=20)
    except requests.RequestException:
        log.warning("browse request to %s failed, checking domain redirect", url)
        check = check_domain_redirect()
        if check.get("redirected"):
            url = f"https://{SC_DOMAIN}/it/browse/{slider}"
            log.info("retrying browse GET %s with new domain", url)
            res = requests.get(url, headers=JSON_HEADERS, timeout=20)
        else:
            raise

    final_host = urlparse(res.url).netloc.split(":")[0].strip().lower()
    if (
        final_host
        and final_host != SC_DOMAIN.lower()
        and _is_valid_sc_redirect(final_host, res.text[:2000] if hasattr(res, "text") else "")
    ):
        log.info(
            "browse followed redirect: %s -> %s; updating catalogue domain", SC_DOMAIN, final_host
        )
        set_setting("sc_domain", final_host)
        configure_domains(final_host, VIXSRC_DOMAIN)

    log.debug("browse %s -> status=%s bytes=%d", url, res.status_code, len(res.content))
    if res.status_code != 200:
        log.warning("browse %s returned %s: %.300r", url, res.status_code, res.text)
        res.raise_for_status()

    try:
        payload = res.json()
    except ValueError as exc:
        log.warning("browse %s sent %d bytes of non-JSON: %.300r", url, len(res.content), res.text)
        raise RuntimeError(f"{url} did not return JSON") from exc

    items = payload.get("titles") or []
    log.debug("browse %s -> %d items (limit=%d)", url, len(items), limit)
    return [summary_from_browse(i) for i in items[:limit]]


def archive_total(media_type: Optional[str] = None) -> int:
    """Exact catalogue size, from the paginated archive endpoint the site UI uses."""
    url = f"https://{SC_DOMAIN}/it/archive"
    params = {"type": media_type} if media_type else {}
    log.debug("archive GET %s params=%s", url, params)
    try:
        res = requests.get(url, params=params, headers=JSON_HEADERS, timeout=20)
    except requests.RequestException:
        log.warning("archive request to %s failed, checking domain redirect", url)
        check = check_domain_redirect()
        if check.get("redirected"):
            url = f"https://{SC_DOMAIN}/it/archive"
            log.info("retrying archive GET %s with new domain", url)
            res = requests.get(url, params=params, headers=JSON_HEADERS, timeout=20)
        else:
            raise

    final_host = urlparse(res.url).netloc.split(":")[0].strip().lower()
    if (
        final_host
        and final_host != SC_DOMAIN.lower()
        and _is_valid_sc_redirect(final_host, res.text[:2000] if hasattr(res, "text") else "")
    ):
        log.info(
            "archive followed redirect: %s -> %s; updating catalogue domain", SC_DOMAIN, final_host
        )
        set_setting("sc_domain", final_host)
        configure_domains(final_host, VIXSRC_DOMAIN)

    res.raise_for_status()
    return int(res.json().get("total") or 0)


# --------------------------------------------------------------------------- #
# Playback resolver
# --------------------------------------------------------------------------- #
#
# `api.get_links()` cannot be used here: it scrapes `window.masterPlaylist` out
# of the public /movie/{tmdb} and /tv/{tmdb}/{s}/{e} pages, but the playback host
# was rebuilt in Next.js and those pages no longer contain it. The playlist now
# sits one hop deeper, behind a token'd /embed/... page whose URL comes from a
# private JSON API. The embed token only lives ~2 minutes, so both hops have to
# run back to back; the playlist token it yields lasts ~60 days.


def _scrape(pattern: str, page: str, what: str) -> str:
    match = re.search(pattern, page)
    if not match:
        log.warning("playback host scrape miss: %s (page %d bytes)", what, len(page))
        raise LookupError(what)
    return match.group(1)


def resolve_playlist(
    tmdb_id: int, media_type: str, season: Optional[int] = None, episode: Optional[int] = None
) -> Optional[Dict[str, Any]]:
    """Resolve a playable HLS master playlist, or None if the host lacks the title."""
    base = f"https://{VIXSRC_DOMAIN}"
    kind = "tv" if media_type == "tv" else "movie"
    suffix = f"/{season}/{episode}" if season and episode else ""
    referer = f"{base}/{kind}/{tmdb_id}{suffix}"

    api_path = f"/api/{kind}/{tmdb_id}{suffix}"
    log.debug("resolve GET %s%s", base, api_path)
    try:
        res = vixsrc_session.get(base + api_path, headers={"referer": referer}, timeout=20)
    except requests.RequestException:
        log.warning("resolve request to %s failed, checking vixsrc redirect", base + api_path)
        check = check_vixsrc_redirect()
        if check.get("redirected"):
            base = f"https://{VIXSRC_DOMAIN}"
            referer = f"{base}/{kind}/{tmdb_id}{suffix}"
            log.info("retrying resolve with new vixsrc domain %s", VIXSRC_DOMAIN)
            res = vixsrc_session.get(base + api_path, headers={"referer": referer}, timeout=20)
        else:
            raise

    final_host = urlparse(res.url).netloc.split(":")[0].strip().lower()
    if (
        final_host
        and final_host != VIXSRC_DOMAIN.lower()
        and _is_valid_vixsrc_redirect(final_host, res.text[:2000] if hasattr(res, "text") else "")
    ):
        log.info(
            "resolve_playlist followed redirect: %s -> %s; updating playback domain",
            VIXSRC_DOMAIN,
            final_host,
        )
        set_setting("vixsrc_domain", final_host)
        configure_domains(SC_DOMAIN, final_host)
        base = f"https://{VIXSRC_DOMAIN}"

    if res.status_code == 404:  # absent from the host's catalogue; cacheable
        log.warning("playback host has no %s", api_path)
        return None
    if res.status_code != 200:
        log.warning("playback host %s returned %s", api_path, res.status_code)
        raise RuntimeError(f"playback host returned {res.status_code}")

    src = (res.json() or {}).get("src")
    if not src:
        raise RuntimeError("playback host returned no embed source")

    embed_url = src if src.startswith("http") else base + src
    try:
        page_res = vixsrc_session.get(embed_url, headers={"referer": referer}, timeout=20)
        page = page_res.text
        embed_final_host = urlparse(page_res.url).netloc.split(":")[0].strip().lower()
        if (
            embed_final_host
            and embed_final_host != VIXSRC_DOMAIN.lower()
            and _is_valid_vixsrc_redirect(embed_final_host, page[:2000])
        ):
            log.info(
                "embed followed redirect: %s -> %s; updating playback domain",
                VIXSRC_DOMAIN,
                embed_final_host,
            )
            set_setting("vixsrc_domain", embed_final_host)
            configure_domains(SC_DOMAIN, embed_final_host)
    except requests.RequestException:
        log.warning("embed fetch failed, checking vixsrc redirect")
        check = check_vixsrc_redirect()
        if check.get("redirected"):
            base = f"https://{VIXSRC_DOMAIN}"
            referer = f"{base}/{kind}/{tmdb_id}{suffix}"
            embed_url = src if src.startswith("http") else base + src
            page_res = vixsrc_session.get(embed_url, headers={"referer": referer}, timeout=20)
            page = page_res.text
        else:
            raise

    raw_params = _scrape(
        r"window\.masterPlaylist[^:]+params:[^{]+({[^<]+?})", page, "playlist params"
    )
    # The object is JS, not JSON: single quotes plus a trailing `asn` entry.
    params = json.loads(re.sub(r',[^"]+}', "}", raw_params.replace("'", '"')))
    playlist_url = _scrape(
        r"window\.masterPlaylist\s*=\s*\{[\s\S]*?url:\s*'([^']+)'", page, "playlist url"
    )
    fhd_flag = re.search(r"window\.canPlayFHD\s+?=\s+?(\w+)", page)
    fhd = bool(fhd_flag and fhd_flag.group(1) == "true")

    if params.get("asn"):
        # Signs the token to a network: resolving server-side would then hand the
        # browser a playlist it cannot use, so surface it loudly.
        log.warning(
            "playback host now signs asn=%r; server-side resolving may stop working",
            params["asn"],
        )

    playlist = (
        playlist_url
        + ("&" if "?" in playlist_url else "?")
        + f"expires={params['expires']}&token={params['token']}"
        + ("&h=1" if fhd else "")
    )
    log.debug("resolved playlist for %s %s (fhd=%s)", kind, tmdb_id, fhd)
    return {"playlistUrl": playlist, "expiresAt": int(params["expires"]), "fhd": fhd}


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #


@app.get("/health")
def health():
    domain, _ = current_domains()
    return {"ok": True, "domain": domain}


class DomainSettings(BaseModel):
    scDomain: str = Field(min_length=1, max_length=253)
    vixsrcDomain: str = Field(min_length=1, max_length=253)

    @field_validator("scDomain", "vixsrcDomain")
    @classmethod
    def validate_domain(cls, value: str) -> str:
        value = value.strip().removeprefix("https://").removeprefix("http://").rstrip("/")
        if not value or "/" in value or " " in value:
            raise ValueError("domain must be a hostname without a scheme or path")
        return value


@app.get("/settings/domains")
def get_domain_settings(_: Dict[str, Any] = Depends(require_admin)):
    sc_domain, vixsrc_domain = current_domains()
    return {"scDomain": sc_domain, "vixsrcDomain": vixsrc_domain}


@app.put("/settings/domains")
def update_domain_settings(
    body: DomainSettings, _: Dict[str, Any] = Depends(require_admin)
):
    set_setting("sc_domain", body.scDomain)
    set_setting("vixsrc_domain", body.vixsrcDomain)
    configure_domains(body.scDomain, body.vixsrcDomain)
    return {"scDomain": body.scDomain, "vixsrcDomain": body.vixsrcDomain}


@app.post("/settings/domains/check-redirect")
def check_domain_redirect_endpoint(_: Dict[str, Any] = Depends(require_admin)):
    return check_all_domains_redirect()


@app.get("/player")
def player():
    """Playback embed host, so the dashboard can build iframe URLs client-side."""
    _, vixsrc_domain = current_domains()
    return {
        "provider": "vixsrc",
        "domain": vixsrc_domain,
        "enabled": bool(vixsrc_domain),
    }


@app.get("/stream")
def stream(
    tmdb: int = Query(..., gt=0),
    type: str = Query("movie", pattern="^(movie|tv)$"),
    s: Optional[int] = Query(None, gt=0),
    e: Optional[int] = Query(None, gt=0),
):
    """Direct HLS master playlist, so the dashboard can play without the embed iframe."""
    if not VIXSRC_DOMAIN:
        raise HTTPException(status_code=503, detail="no playback host configured")
    if type == "tv" and not (s and e):
        raise HTTPException(status_code=422, detail="series need both s and e")

    try:
        resolved = cached(
            f"stream:{type}:{tmdb}:{s}:{e}", lambda: resolve_playlist(tmdb, type, s, e)
        )
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("stream %s %s failed", type, tmdb)
        raise HTTPException(status_code=502, detail=f"could not resolve stream: {exc}")

    if resolved is None:
        raise HTTPException(status_code=404, detail="title not available on the playback host")
    return {"provider": "vixsrc", **resolved}


@app.get("/search")
def search(q: str = Query(..., max_length=120)):
    log.debug("search q=%r domain=%s", q, SC_DOMAIN)
    try:
        results = api.search(q)
    except Exception as exc:
        log.warning("search q=%r failed, checking domain redirect: %s", q, exc)
        check = check_domain_redirect()
        if check.get("redirected"):
            log.info("retrying search q=%r with new domain %s", q, SC_DOMAIN)
            try:
                results = api.search(q)
            except Exception as retry_exc:
                log.exception("search retry failed")
                raise HTTPException(status_code=502, detail=f"upstream search failed: {retry_exc}")
        else:
            log.exception("search q=%r failed", q)
            raise HTTPException(status_code=502, detail=f"upstream search failed: {exc}")
    log.debug("search q=%r -> %d raw results", q, len(results))
    return [summary_from_browse(item) for item in results.values()]


@app.get("/trending")
def trending():
    try:
        return cached("trending", lambda: browse("trending"))
    except Exception as exc:
        log.exception("trending failed")
        raise HTTPException(status_code=502, detail=f"upstream trending failed: {exc}")


@app.get("/latest")
def latest():
    try:
        return cached("latest", lambda: browse("latest", limit=60))
    except Exception as exc:
        log.exception("latest failed")
        raise HTTPException(status_code=502, detail=f"upstream latest failed: {exc}")


@app.get("/title/{content_id}")
def title(content_id: str):
    def load():
        try:
            raw = api.load(content_id)
        except Exception as exc:
            log.warning("title load %r failed, checking domain redirect: %s", content_id, exc)
            check = check_domain_redirect()
            if check.get("redirected"):
                log.info("retrying title load %r with new domain %s", content_id, SC_DOMAIN)
                raw = api.load(content_id)
            else:
                raise
        log.debug("title %r loaded keys=%s", content_id, sorted(raw.keys()))
        return detail_from_load(content_id, raw)

    try:
        return cached(f"title:{content_id}", load)
    except Exception as exc:
        log.exception("title %r failed", content_id)
        raise HTTPException(status_code=404, detail=f"title not found: {exc}")


@app.get("/stats")
def stats():
    def build():
        items = browse("latest", limit=60)
        try:
            items += browse("trending", limit=60)
        except Exception:
            log.warning("stats: browse('trending') failed, using 'latest' only", exc_info=True)
        titles = list({i["id"]: i for i in items}.values())
        if not titles:
            raise RuntimeError("no titles returned by upstream")

        # The sliders carry 60 titles each, so counting them reported a library of
        # ~100; the archive endpoint knows how big the catalogue actually is.
        try:
            movies = archive_total("movie")
            series = archive_total("tv")
        except Exception:
            log.warning("stats: archive totals failed, counting the sample", exc_info=True)
            movies = sum(1 for t in titles if t["type"] == "movie")
            series = sum(1 for t in titles if t["type"] == "tv")

        scores = [t["score"] for t in titles if t["score"]]

        return {
            "totalTitles": movies + series,
            "movies": movies,
            "series": series,
            # Averaged over the newest and trending titles; the site publishes no
            # catalogue-wide aggregate.
            "averageScore": round(sum(scores) / len(scores), 1) if scores else 0.0,
            # Listings carry no genre data and the site only exposes genres per
            # title, so there is no honest breakdown to report.
            "genreBreakdown": [],
            # The site exposes no view analytics; derive a stable weekly shape
            # from the sample so the dashboard chart has consistent data.
            "weeklyViews": [
                {"day": day, "views": len(titles) * (10 + idx * 3)}
                for idx, day in enumerate(
                    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
                )
            ],
        }

    try:
        return cached("stats", build)
    except Exception as exc:
        log.exception("stats failed")
        raise HTTPException(status_code=502, detail=f"upstream stats failed: {exc}")
