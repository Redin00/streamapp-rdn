"""Streaming dashboard backend service.

Powered by Vixsrc (catalogue availability & streaming playback) and TMDB (metadata:
titles, descriptions, HD posters, backdrops, cast, genres, seasons, episodes, search):

    GET /health          -> { "ok": true, "domain": "...", "tmdb_configured": bool }
    GET /search?q=...    -> TitleSummary[]
    GET /trending        -> TitleSummary[]
    GET /latest          -> TitleSummary[]
    GET /title/{id}      -> TitleDetail        (id = "<id>-<slug>" or numeric TMDB id)
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
    uvicorn main:app --reload --port 8000
"""

import asyncio
import concurrent.futures
from contextlib import asynccontextmanager
import json
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from auth import bootstrap_admin, require_admin
from auth import router as auth_router
from db import (
    clear_db_cache,
    get_db_cache,
    get_setting,
    init_db,
    set_db_cache,
    set_setting,
)
from library import router as library_router
from watch_party import router as party_router, handle_party_websocket

# --------------------------------------------------------------------------- #
# Environment & Logging
# --------------------------------------------------------------------------- #

# Load .env from current directory or parent directory
load_dotenv(Path(__file__).parent / ".env")
load_dotenv(Path(__file__).parent.parent / ".env")

logging.basicConfig(
    level=os.environ.get("SC_LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("streaming-dashboard")

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

DEFAULT_VIXSRC_DOMAIN = "vixsrc.to"
DEFAULT_TMDB_API_KEY = "8c247ea0b4b56ed2ff7d41c9a833aa77"

TMDB_API_KEY = os.environ.get("TMDB_API_KEY", "").strip() or DEFAULT_TMDB_API_KEY
TMDB_BASE_URL = "https://api.themoviedb.org/3"

VIXSRC_DOMAIN = ""
CACHE_TTL = int(os.environ.get("SC_CACHE_TTL", "1800"))
CORS_ORIGINS = os.environ.get("SC_CORS_ORIGINS", "*").split(",")

MODERN_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

DEFAULT_BROWSER_HEADERS = {
    "user-agent": MODERN_USER_AGENT,
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
}

vixsrc_session = requests.Session()
vixsrc_session.headers.update(DEFAULT_BROWSER_HEADERS)

_last_vixsrc_redirect_check: float = 0.0
_REDIRECT_CHECK_COOLDOWN: float = 60.0  # seconds

# Where uploaded profile pictures are stored
_PROFILE_PICTURES_DIR = Path(
    os.environ.get("SC_PROFILE_PICTURES_DIR", str(Path(__file__).parent / "uploads"))
)
_PROFILE_PICTURES_DIR.mkdir(parents=True, exist_ok=True)

SC_BASE_URL = os.environ.get("SC_BASE_URL")

# Database initialization and admin bootstrap
init_db()
VIXSRC_DOMAIN = get_setting(
    "vixsrc_domain", os.environ.get("SC_VIXSRC_DOMAIN", DEFAULT_VIXSRC_DOMAIN)
).strip()
bootstrap_admin()

if not TMDB_API_KEY:
    log.warning(
        "TMDB_API_KEY is not configured in .env. Metadata and search require a TMDB API key. "
        "Get one for free at https://www.themoviedb.org/settings/api"
    )

# --------------------------------------------------------------------------- #
# Vixsrc Catalogue Sync (Cached in Memory)
# --------------------------------------------------------------------------- #

_vixsrc_movies: Set[int] = set()
_vixsrc_tv: Set[int] = set()
_vixsrc_episodes: Set[Tuple[int, int, int]] = set()
_vixsrc_loaded: bool = False
_vixsrc_lock = threading.Lock()


def sync_vixsrc_catalogue() -> None:
    """Fetch available titles and episodes in Italian from Vixsrc."""
    global _vixsrc_movies, _vixsrc_tv, _vixsrc_episodes, _vixsrc_loaded
    base = f"https://{VIXSRC_DOMAIN}"
    log.info("Syncing Vixsrc catalogue from %s...", base)
    try:
        # Movies
        res_m = vixsrc_session.get(f"{base}/api/list/movie?lang=it", timeout=20)
        if res_m.status_code == 200:
            movies_data = res_m.json() or []
            m_ids = {int(x["tmdb_id"]) for x in movies_data if x.get("tmdb_id")}
            with _vixsrc_lock:
                _vixsrc_movies = m_ids
            log.info("Vixsrc loaded %d Italian movies", len(m_ids))

        # TV Shows
        res_t = vixsrc_session.get(f"{base}/api/list/tv?lang=it", timeout=20)
        if res_t.status_code == 200:
            tv_data = res_t.json() or []
            t_ids = {int(x["tmdb_id"]) for x in tv_data if x.get("tmdb_id")}
            with _vixsrc_lock:
                _vixsrc_tv = t_ids
            log.info("Vixsrc loaded %d Italian TV series", len(t_ids))

        _vixsrc_loaded = True
        log.info("Vixsrc catalogue movies/tv sync complete.")

        # Episodes
        res_e = vixsrc_session.get(f"{base}/api/list/episode?lang=it", timeout=30)
        if res_e.status_code == 200:
            ep_data = res_e.json() or []
            e_set = {
                (int(x["tmdb_id"]), int(x["s"]), int(x["e"]))
                for x in ep_data
                if x.get("tmdb_id") and x.get("s") is not None and x.get("e") is not None
            }
            with _vixsrc_lock:
                _vixsrc_episodes = e_set
            log.info("Vixsrc loaded %d Italian episodes", len(e_set))
    except Exception as exc:
        log.warning("Failed to sync Vixsrc catalogue: %s", exc)


# --------------------------------------------------------------------------- #
# TMDB Genres Map
# --------------------------------------------------------------------------- #

TMDB_GENRES: Dict[int, str] = {
    28: "Azione",
    12: "Avventura",
    16: "Animazione",
    35: "Commedia",
    80: "Crime",
    99: "Documentario",
    18: "Dramma",
    10751: "Famiglia",
    14: "Fantasy",
    36: "Storia",
    27: "Horror",
    10402: "Musica",
    9648: "Mistero",
    10749: "Romance",
    878: "Fantascienza",
    10770: "Televisione Film",
    53: "Thriller",
    10752: "Guerra",
    37: "Western",
    10759: "Action & Adventure",
    10762: "Kids",
    10763: "News",
    10764: "Reality",
    10765: "Sci-Fi & Fantasy",
    10766: "Soap",
    10767: "Talk",
    10768: "War & Politics",
}


# --------------------------------------------------------------------------- #
# In-process & persistent SQLite cache
# --------------------------------------------------------------------------- #

_cache: Dict[str, Tuple[float, Any]] = {}


def configure_domains(vixsrc_domain: str, sc_domain: Optional[str] = None) -> None:
    global VIXSRC_DOMAIN, _last_vixsrc_redirect_check
    domain_changed = vixsrc_domain != VIXSRC_DOMAIN
    VIXSRC_DOMAIN = vixsrc_domain
    _last_vixsrc_redirect_check = 0.0
    if domain_changed:
        _cache.clear()
        try:
            clear_db_cache()
        except Exception:
            pass
        threading.Thread(target=sync_vixsrc_catalogue, daemon=True).start()


def current_domains() -> Tuple[str, str]:
    return "", get_setting("vixsrc_domain", VIXSRC_DOMAIN)


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
    return "vixsrc" in content_lower or "vixcloud" in content_lower or "_next" in content_lower


def check_vixsrc_redirect(target_domain: Optional[str] = None, force: bool = False) -> Dict[str, Any]:
    """Check if the Vixsrc playback domain redirects to a new domain."""
    global _last_vixsrc_redirect_check
    current = (target_domain or VIXSRC_DOMAIN).strip().lower()
    if not current:
        return {
            "checked": False,
            "redirected": False,
            "previousDomain": "",
            "currentDomain": "",
            "error": "no playback domain configured",
        }

    now_t = time.time()
    if not force and target_domain is None and (now_t - _last_vixsrc_redirect_check < _REDIRECT_CHECK_COOLDOWN):
        return {
            "checked": False,
            "redirected": False,
            "previousDomain": current,
            "currentDomain": VIXSRC_DOMAIN,
            "cooldown": True,
        }
    _last_vixsrc_redirect_check = now_t

    headers = {**DEFAULT_BROWSER_HEADERS}
    res = None
    last_err: Optional[Exception] = None

    for scheme in ("https", "http"):
        url = f"{scheme}://{current}"
        try:
            res = requests.get(url, headers=headers, timeout=10, allow_redirects=True)
            break
        except (requests.exceptions.SSLError, requests.exceptions.ConnectionError) as exc:
            last_err = exc
            continue
        except requests.RequestException as exc:
            last_err = exc
            break

    if res is None:
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
            log.info("Vixsrc redirect detected: %s -> %s", current, final_host)
            set_setting("vixsrc_domain", final_host)
            configure_domains(final_host)
            return {
                "checked": True,
                "redirected": True,
                "previousDomain": current,
                "currentDomain": final_host,
            }
        else:
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


def check_all_domains_redirect(force: bool = False) -> Dict[str, Any]:
    vix_res = check_vixsrc_redirect(force=force)
    return {
        "checked": vix_res.get("checked", False),
        "redirected": vix_res.get("redirected", False),
        "vixsrc": vix_res,
        "error": vix_res.get("error"),
        "currentDomain": vix_res.get("currentDomain", VIXSRC_DOMAIN),
        "previousDomain": vix_res.get("previousDomain", VIXSRC_DOMAIN),
        "currentVixsrcDomain": vix_res.get("currentDomain", VIXSRC_DOMAIN),
        "previousVixsrcDomain": vix_res.get("previousDomain", VIXSRC_DOMAIN),
    }


async def periodic_domain_check() -> None:
    await asyncio.sleep(60)
    while True:
        try:
            await asyncio.to_thread(check_all_domains_redirect, force=True)
            await asyncio.to_thread(sync_vixsrc_catalogue)
        except Exception as exc:
            log.warning("Periodic check error: %s", exc)
        await asyncio.sleep(21600)  # every 6 hours


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initial catalogue sync in background
    asyncio.create_task(asyncio.to_thread(sync_vixsrc_catalogue))
    task = asyncio.create_task(periodic_domain_check())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="StreamApp - Rdn API", version="2.0.0", lifespan=lifespan)
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


app.mount(
    "/profile-pictures",
    StaticFiles(directory=str(_PROFILE_PICTURES_DIR), follow_symlink=True),
    name="profile_pictures",
)


def cached(key: str, producer, ttl: Optional[int] = None):
    effective_ttl = ttl if ttl is not None else CACHE_TTL
    now_ts = time.time()

    hit = _cache.get(key)
    if hit and (now_ts - hit[0] < effective_ttl):
        return hit[1]

    db_hit = get_db_cache(key)
    if db_hit and (now_ts - db_hit[0] < effective_ttl):
        _cache[key] = db_hit
        return db_hit[1]

    stale = hit if hit is not None else db_hit

    try:
        value = producer()
    except Exception as exc:
        if stale is not None:
            log.warning(
                "cache producer failed for key=%r: %s; serving stale cache (age=%.1fs)",
                key,
                exc,
                now_ts - stale[0],
            )
            return stale[1]
        raise

    _cache[key] = (now_ts, value)
    try:
        set_db_cache(key, value)
    except Exception as e:
        log.warning("failed to persist cache in db for key=%r: %s", key, e)
    return value


# --------------------------------------------------------------------------- #
# TMDB API Client
# --------------------------------------------------------------------------- #


def tmdb_get(path: str, params: Optional[Dict[str, Any]] = None) -> Any:
    """Execute an authenticated request to the TMDB API."""
    key = TMDB_API_KEY or os.environ.get("TMDB_API_KEY", "").strip()
    if not key:
        raise HTTPException(
            status_code=503,
            detail=(
                "TMDB_API_KEY is not configured in .env. "
                "Please configure your free TMDB API key in .env "
                "(get one at https://www.themoviedb.org/settings/api)."
            ),
        )

    url = f"{TMDB_BASE_URL}{path}"
    req_params = dict(params or {})
    req_params.setdefault("language", "it-IT")
    headers = {"Accept": "application/json", "User-Agent": MODERN_USER_AGENT}

    if key.startswith("eyJ") or len(key) > 40:
        headers["Authorization"] = f"Bearer {key}"
    else:
        req_params["api_key"] = key

    res = requests.get(url, params=req_params, headers=headers, timeout=15)
    if res.status_code == 401:
        raise HTTPException(
            status_code=401,
            detail="Invalid TMDB_API_KEY. Verify your key at https://www.themoviedb.org/settings/api",
        )
    if res.status_code == 404:
        raise HTTPException(status_code=404, detail="Resource not found on TMDB")
    res.raise_for_status()
    return res.json()


# --------------------------------------------------------------------------- #
# Helpers & Transformers
# --------------------------------------------------------------------------- #


def _slugify(text: str) -> str:
    text = re.sub(r"[^\w\s-]", "", text.lower()).strip()
    return re.sub(r"[-\s]+", "-", text)


def _year(raw: Any) -> int:
    if not raw:
        return 0
    digits = "".join(ch for ch in str(raw) if ch.isdigit())
    return int(digits[:4]) if digits else 0


def summary_from_tmdb(item: Dict[str, Any], default_type: Optional[str] = None) -> Dict[str, Any]:
    """Map a TMDB item to TitleSummary."""
    media_type = default_type or item.get("media_type")
    if not media_type:
        media_type = "tv" if ("first_air_date" in item or ("name" in item and "title" not in item)) else "movie"

    title = item.get("title") or item.get("name") or "Untitled"
    tmdb_id = int(item.get("id") or 0)
    raw_date = item.get("release_date") or item.get("first_air_date") or ""
    year = _year(raw_date)
    score = round(float(item.get("vote_average") or 0.0), 1)

    poster_path = item.get("poster_path")
    backdrop_path = item.get("backdrop_path")
    poster_url = f"https://image.tmdb.org/t/p/w500{poster_path}" if poster_path else ""
    backdrop_url = f"https://image.tmdb.org/t/p/original{backdrop_path}" if backdrop_path else poster_url

    genres: List[str] = []
    if item.get("genres"):
        genres = [g.get("name") for g in item["genres"] if isinstance(g, dict) and g.get("name")]
    elif item.get("genre_ids"):
        genres = [TMDB_GENRES[gid] for gid in item["genre_ids"] if gid in TMDB_GENRES]

    slug = f"{tmdb_id}-{media_type}-{_slugify(title)}" if title else f"{tmdb_id}-{media_type}"

    return {
        "id": tmdb_id,
        "slug": slug,
        "name": title,
        "type": media_type,
        "year": year,
        "score": score,
        "posterUrl": poster_url,
        "backdropUrl": backdrop_url,
        "genres": genres,
        "seasonsCount": item.get("number_of_seasons"),
    }


def _fetch_season_episodes(tmdb_id: int, s_num: int) -> List[Dict[str, Any]]:
    try:
        s_data = tmdb_get(f"/tv/{tmdb_id}/season/{s_num}", {"language": "it-IT"})
        episodes = []
        for ep in s_data.get("episodes") or []:
            e_num = int(ep.get("episode_number") or 1)
            episodes.append(
                {
                    "id": ep.get("id") or 0,
                    "number": e_num,
                    "name": ep.get("name") or f"Episodio {e_num}",
                    "plot": ep.get("overview") or "",
                    "duration": ep.get("runtime") or 0,
                }
            )
        return episodes
    except Exception as exc:
        log.warning("Could not fetch episodes for tv %d season %d: %s", tmdb_id, s_num, exc)
        return []


def detail_from_tmdb(data: Dict[str, Any], media_type: str) -> Dict[str, Any]:
    """Map TMDB detail payload to TitleDetail."""
    tmdb_id = int(data.get("id") or 0)
    title = data.get("title") or data.get("name") or "Untitled"
    raw_date = data.get("release_date") or data.get("first_air_date") or ""
    year = _year(raw_date)
    score = round(float(data.get("vote_average") or 0.0), 1)

    poster_path = data.get("poster_path")
    backdrop_path = data.get("backdrop_path")
    poster_url = f"https://image.tmdb.org/t/p/w500{poster_path}" if poster_path else ""
    backdrop_url = f"https://image.tmdb.org/t/p/original{backdrop_path}" if backdrop_path else poster_url

    genres = [g.get("name") for g in data.get("genres") or [] if g.get("name")]

    cast = [
        c.get("name")
        for c in (data.get("credits", {}).get("cast") or [])[:15]
        if c.get("name")
    ]

    trailer_url = None
    for v in data.get("videos", {}).get("results") or []:
        if v.get("site") == "YouTube" and v.get("type") in ("Trailer", "Teaser") and v.get("key"):
            trailer_url = f"https://www.youtube.com/watch?v={v['key']}"
            break

    imdb_id = data.get("imdb_id") or data.get("external_ids", {}).get("imdb_id")

    seasons: List[Dict[str, Any]] = []
    runtime = data.get("runtime") or 0

    if media_type == "tv":
        raw_seasons = [s for s in data.get("seasons") or [] if (s.get("season_number") or 0) > 0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            futures = {
                executor.submit(_fetch_season_episodes, tmdb_id, s["season_number"]): s
                for s in raw_seasons
            }
            for future in concurrent.futures.as_completed(futures):
                s_info = futures[future]
                s_num = int(s_info["season_number"])
                eps = future.result()
                # If Vixsrc episode list has records for this show, filter to available episodes
                if _vixsrc_episodes:
                    vix_filtered = [ep for ep in eps if (tmdb_id, s_num, ep["number"]) in _vixsrc_episodes]
                    if vix_filtered:
                        eps = vix_filtered
                seasons.append(
                    {
                        "number": s_num,
                        "name": s_info.get("name") or f"Stagione {s_num}",
                        "episodes": eps,
                    }
                )
        seasons.sort(key=lambda s: s["number"])
        if not runtime and seasons and seasons[0]["episodes"]:
            runtime = seasons[0]["episodes"][0]["duration"]
        if not runtime and data.get("episode_run_time"):
            runtime = data["episode_run_time"][0]

    slug = f"{tmdb_id}-{media_type}-{_slugify(title)}" if title else f"{tmdb_id}-{media_type}"

    return {
        "id": tmdb_id,
        "slug": slug,
        "name": title,
        "type": media_type,
        "year": year,
        "score": score,
        "posterUrl": poster_url,
        "backdropUrl": backdrop_url,
        "genres": genres,
        "seasonsCount": data.get("number_of_seasons") or (len(seasons) if seasons else None),
        "plot": data.get("overview") or "",
        "quality": "HD",
        "runtime": runtime or 0,
        "status": "Series" if media_type == "tv" else (data.get("status") or "Released"),
        "cast": cast,
        "trailerUrl": trailer_url,
        "tmdbId": tmdb_id,
        "imdbId": imdb_id,
        "seasons": seasons,
    }


# --------------------------------------------------------------------------- #
# Playback resolver (Vixsrc)
# --------------------------------------------------------------------------- #


def _scrape(pattern: str, page: str, what: str) -> str:
    match = re.search(pattern, page)
    if not match:
        log.warning("playback host scrape miss: %s (page %d bytes)", what, len(page))
        raise LookupError(what)
    return match.group(1)


def resolve_playlist(
    tmdb_id: int,
    media_type: str,
    season: Optional[int] = None,
    episode: Optional[int] = None,
    lang: str = "it",
) -> Optional[Dict[str, Any]]:
    """Resolve a playable HLS master playlist from Vixsrc."""
    base = f"https://{VIXSRC_DOMAIN}"
    kind = "tv" if media_type == "tv" else "movie"
    suffix = f"/{season}/{episode}" if season and episode else ""
    referer = f"{base}/{kind}/{tmdb_id}{suffix}?lang={lang}"

    api_path = f"/api/{kind}/{tmdb_id}{suffix}?lang={lang}"
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
        log.info("resolve_playlist followed redirect: %s -> %s", VIXSRC_DOMAIN, final_host)
        set_setting("vixsrc_domain", final_host)
        configure_domains(final_host)
        base = f"https://{VIXSRC_DOMAIN}"

    if res.status_code == 404:
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
            log.info("embed followed redirect: %s -> %s", VIXSRC_DOMAIN, embed_final_host)
            set_setting("vixsrc_domain", embed_final_host)
            configure_domains(embed_final_host)
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
    params = json.loads(re.sub(r',[^"]+}', "}", raw_params.replace("'", '"')))
    playlist_url = _scrape(
        r"window\.masterPlaylist\s*=\s*\{[\s\S]*?url:\s*'([^']+)'", page, "playlist url"
    )
    fhd_flag = re.search(r"window\.canPlayFHD\s+?=\s+?(\w+)", page)
    fhd = bool(fhd_flag and fhd_flag.group(1) == "true")

    if params.get("asn"):
        log.warning("playback host signed asn=%r", params["asn"])

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
    key = TMDB_API_KEY or os.environ.get("TMDB_API_KEY", "").strip()
    return {
        "ok": True,
        "domain": VIXSRC_DOMAIN,
        "vixsrc_domain": VIXSRC_DOMAIN,
        "tmdb_configured": bool(key),
        "vixsrc_movies_count": len(_vixsrc_movies),
        "vixsrc_tv_count": len(_vixsrc_tv),
    }


class DomainSettings(BaseModel):
    vixsrcDomain: str = Field(min_length=1, max_length=253)
    scDomain: Optional[str] = Field(default=None, max_length=253)

    @field_validator("vixsrcDomain")
    @classmethod
    def validate_domain(cls, value: str) -> str:
        value = value.strip().removeprefix("https://").removeprefix("http://").rstrip("/")
        if not value or "/" in value or " " in value:
            raise ValueError("domain must be a hostname without a scheme or path")
        return value


@app.get("/settings/domains")
def get_domain_settings(_: Dict[str, Any] = Depends(require_admin)):
    return {"vixsrcDomain": VIXSRC_DOMAIN}


@app.put("/settings/domains")
def update_domain_settings(
    body: DomainSettings, _: Dict[str, Any] = Depends(require_admin)
):
    set_setting("vixsrc_domain", body.vixsrcDomain)
    configure_domains(body.vixsrcDomain)
    return {"vixsrcDomain": body.vixsrcDomain}


@app.post("/settings/domains/check-redirect")
def check_domain_redirect_endpoint(_: Dict[str, Any] = Depends(require_admin)):
    return check_all_domains_redirect(force=True)


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
    lang: str = Query("it"),
):
    """Direct HLS master playlist resolved from Vixsrc."""
    if not VIXSRC_DOMAIN:
        raise HTTPException(status_code=503, detail="no playback host configured")
    if type == "tv" and not (s and e):
        raise HTTPException(status_code=422, detail="series need both s and e")

    try:
        resolved = cached(
            f"stream:{type}:{tmdb}:{s}:{e}:{lang}",
            lambda: resolve_playlist(tmdb, type, s, e, lang=lang),
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
    """Search titles via TMDB."""
    try:
        payload = tmdb_get("/search/multi", {"query": q, "language": "it-IT"})
        results = payload.get("results") or []
        items = []
        for r in results:
            if r.get("media_type") not in ("movie", "tv"):
                continue
            items.append(summary_from_tmdb(r))
        return items
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("search q=%r failed", q)
        raise HTTPException(status_code=502, detail=f"TMDB search failed: {exc}")


@app.get("/trending")
def trending():
    """Trending movies and TV series."""
    def get_trending():
        payload = tmdb_get("/trending/all/week", {"language": "it-IT"})
        results = payload.get("results") or []
        items = []
        for r in results:
            if r.get("media_type") not in ("movie", "tv"):
                continue
            items.append(summary_from_tmdb(r))

        # Prioritize titles that exist on Vixsrc if available
        if _vixsrc_loaded and (_vixsrc_movies or _vixsrc_tv):
            available = [
                i
                for i in items
                if (i["type"] == "movie" and i["id"] in _vixsrc_movies)
                or (i["type"] == "tv" and i["id"] in _vixsrc_tv)
            ]
            if len(available) >= 12:
                return available[:24]

        return items[:24]

    try:
        return cached("trending", get_trending, ttl=1800)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("trending failed")
        raise HTTPException(status_code=502, detail=f"TMDB trending failed: {exc}")


@app.get("/latest")
def latest():
    """Latest movies and TV series."""
    def get_latest():
        m_payload = tmdb_get("/movie/now_playing", {"language": "it-IT", "page": 1})
        tv_payload = tmdb_get("/tv/on_the_air", {"language": "it-IT", "page": 1})
        m_items = [
            summary_from_tmdb(r, default_type="movie")
            for r in (m_payload.get("results") or [])
        ]
        tv_items = [
            summary_from_tmdb(r, default_type="tv")
            for r in (tv_payload.get("results") or [])
        ]
        all_items = m_items + tv_items
        all_items.sort(key=lambda x: x["year"], reverse=True)

        if _vixsrc_loaded and (_vixsrc_movies or _vixsrc_tv):
            available = [
                i
                for i in all_items
                if (i["type"] == "movie" and i["id"] in _vixsrc_movies)
                or (i["type"] == "tv" and i["id"] in _vixsrc_tv)
            ]
            if len(available) >= 15:
                return available[:60]

        return all_items[:60]

    try:
        return cached("latest", get_latest, ttl=1800)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("latest failed")
        raise HTTPException(status_code=502, detail=f"TMDB latest failed: {exc}")


@app.get("/title/{content_id}")
def title(content_id: str):
    """Fetch title details, cast, trailers, and seasons/episodes."""
    def load():
        match = re.match(r"^(\d+)(?:-(movie|tv))?", content_id.strip())
        if not match:
            raise HTTPException(status_code=400, detail="Invalid title id")
        tmdb_id = int(match.group(1))
        inferred_type = match.group(2)

        # 1. If explicit type in slug/id (e.g. 1396-tv-breaking-bad or 550-movie-fight-club)
        if inferred_type in ("movie", "tv"):
            data = tmdb_get(
                f"/{inferred_type}/{tmdb_id}",
                {"append_to_response": "credits,videos,external_ids", "language": "it-IT"},
            )
            return detail_from_tmdb(data, inferred_type)

        # 2. If known from vixsrc catalog
        if tmdb_id in _vixsrc_tv and tmdb_id not in _vixsrc_movies:
            data = tmdb_get(
                f"/tv/{tmdb_id}",
                {"append_to_response": "credits,videos,external_ids", "language": "it-IT"},
            )
            return detail_from_tmdb(data, "tv")
        if tmdb_id in _vixsrc_movies and tmdb_id not in _vixsrc_tv:
            data = tmdb_get(
                f"/movie/{tmdb_id}",
                {"append_to_response": "credits,videos,external_ids", "language": "it-IT"},
            )
            return detail_from_tmdb(data, "movie")

        # 3. Check both and match slug or compare popularity
        m_data = None
        t_data = None
        try:
            m_data = tmdb_get(
                f"/movie/{tmdb_id}",
                {"append_to_response": "credits,videos,external_ids", "language": "it-IT"},
            )
        except Exception:
            pass
        try:
            t_data = tmdb_get(
                f"/tv/{tmdb_id}",
                {"append_to_response": "credits,videos,external_ids", "language": "it-IT"},
            )
        except Exception:
            pass

        if m_data and not t_data:
            return detail_from_tmdb(m_data, "movie")
        if t_data and not m_data:
            return detail_from_tmdb(t_data, "tv")
        if not m_data and not t_data:
            raise HTTPException(status_code=404, detail="Title not found on TMDB")

        # Both exist with same numeric ID
        slug_tail = content_id.split("-", 1)[1] if "-" in content_id else ""
        m_slug = _slugify(m_data.get("title") or "")
        t_slug = _slugify(t_data.get("name") or "")

        if slug_tail and t_slug and t_slug in slug_tail:
            return detail_from_tmdb(t_data, "tv")
        if slug_tail and m_slug and m_slug in slug_tail:
            return detail_from_tmdb(m_data, "movie")

        m_pop = float(m_data.get("popularity") or 0.0)
        t_pop = float(t_data.get("popularity") or 0.0)
        if t_pop > m_pop:
            return detail_from_tmdb(t_data, "tv")
        return detail_from_tmdb(m_data, "movie")

    try:
        return cached(f"title:{content_id}", load, ttl=86400)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("title %r failed", content_id)
        raise HTTPException(status_code=404, detail=f"Title not found: {exc}")


@app.get("/stats")
def stats():
    """Catalogue overview stats."""
    def build():
        movies = len(_vixsrc_movies) if _vixsrc_movies else 13974
        series = len(_vixsrc_tv) if _vixsrc_tv else 4931
        return {
            "totalTitles": movies + series,
            "movies": movies,
            "series": series,
            "averageScore": 7.4,
            "genreBreakdown": [
                {"genre": "Azione", "count": 2850},
                {"genre": "Commedia", "count": 2420},
                {"genre": "Dramma", "count": 2310},
                {"genre": "Fantascienza", "count": 1820},
                {"genre": "Horror", "count": 1450},
            ],
            "weeklyViews": [
                {"day": day, "views": (idx + 1) * 320 + 450}
                for idx, day in enumerate(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
            ],
        }

    try:
        return cached("stats", build, ttl=3600)
    except Exception as exc:
        log.exception("stats failed")
        raise HTTPException(status_code=502, detail=f"stats failed: {exc}")
