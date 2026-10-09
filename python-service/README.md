# StreamApp - Rdn — Python Service

FastAPI backend service powering the streaming dashboard.
Integrates **The Movie Database (TMDB)** for rich metadata and **Vixsrc** for catalogue availability and direct HLS streaming playback.

## Run locally

```bash
cd python-service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Verify the service:
```bash
curl localhost:8000/health
```

## Or with Docker

```bash
docker build -t streaming-api python-service
docker run -p 8000:8000 -e TMDB_API_KEY=your_key streaming-api
```

## Connect the dashboard

Set the environment variable `STREAMING_API_URL` for the web app to the service
URL (e.g. `http://localhost:8000`).

For local development, configure the service from the repository-root `.env`
file. Copy `../.env.example` to `../.env`; `npm run dev` loads it automatically.

Make sure to set `TMDB_API_KEY` in `.env` (free at https://www.themoviedb.org/settings/api).

## Endpoints

| Endpoint          | Returns                                     | Source                         |
| ----------------- | ------------------------------------------- | ------------------------------ |
| `GET /health`     | `{ ok, domain, tmdb_configured, ... }`      | —                              |
| `GET /player`     | `{ provider, domain, enabled }`             | Vixsrc host                    |
| `GET /stream`     | `{ provider, playlistUrl, expiresAt, fhd }` | Vixsrc API + token scrape      |
| `GET /search?q=`  | `TitleSummary[]`                            | TMDB Multi Search              |
| `GET /trending`   | `TitleSummary[]`                            | TMDB Trending filtered/sorted  |
| `GET /latest`     | `TitleSummary[]`                            | TMDB Now Playing & Airing      |
| `GET /title/{id}` | `TitleDetail` (seasons, episodes, `tmdbId`) | TMDB Movie/TV details          |
| `GET /stats`      | `LibraryStats`                              | Vixsrc catalogue size          |

`{id}` is the numeric TMDB id or the slug formatted as `"<tmdbId>-<title>"`.

## Architecture Notes

- **Metadata**: Titles, posters, descriptions, release years, vote ratings, cast, genres, and TV seasons/episodes are obtained from TMDB in Italian (`it-IT`).
- **Availability & Playback**: Vixsrc indexes available Italian movies (`/api/list/movie?lang=it`), series (`/api/list/tv?lang=it`), and episodes (`/api/list/episode?lang=it`).
- **Direct Stream Extraction**: `resolve_playlist()` calls Vixsrc's private `/api/{movie,tv}/...` JSON endpoint, fetches the token'd `/embed/...` page, and parses `window.masterPlaylist`. The resulting token lasts ~60 days, while the embed token lives ~2 minutes.
- **Cache**: Responses and playlists are cached in-memory and persistently in SQLite (`streamapp.db`), with configurable TTL (`SC_CACHE_TTL`, default 1800s).
- **Domain Rotation & Precedence**: Vixsrc domain rotation is monitored and updated dynamically via `check_vixsrc_redirect()`. The initial host is configured via `SC_VIXSRC_DOMAIN` in `.env` (default `vixsrc.to`). Once modified from `/admin` or updated via an automatic redirect, the active domain is stored in SQLite (`app_settings`) and takes precedence over `.env`.

