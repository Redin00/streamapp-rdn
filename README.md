# 📺 StreamApp - Rdn

[Italiano](./README.it.md)

A web dashboard for browsing films and series — catalogue, ratings, seasons,
episodes, cast, and trailers — powered by **The Movie Database (TMDB)** for rich
metadata and **Vixsrc** for streaming availability and playback via direct HLS streams.

## Architecture

- **Metadata Provider**: [The Movie Database (TMDB)](https://www.themoviedb.org/) provides official titles, localized descriptions (Italian), HD posters and backdrops, cast & crew credits, trailers, genres, and TV season/episode details.
- **Streaming & Availability**: [Vixsrc](https://vixsrc.to/) indexes titles and episodes available in Italian (`/api/list/movie`, `/api/list/tv`, `/api/list/episode`) and resolves direct HLS master playlists for playback without ads or third-party trackers.
- **Full Compatibility**: Retains all existing features including multi-user accounts, watchlist/history library, admin controls, and Watch Together synchronized sessions.

## Development

You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating) — plus Python 3.10+.

```sh
git clone https://github.com/Redin00/streamapp-rdn
cd streamapp-rdn/
cp .env.example .env
npm i
npm run dev
```

Copy `.env.example` to `.env` in the repository root and configure your `TMDB_API_KEY`.
`npm run dev` loads that file for both the Python service and Vite; variables already exported in the shell take precedence.

`npm run dev` starts both the Python streaming API service and the Vite dev
server, and connects them automatically via `STREAMING_API_URL`. You can still
run the Python service manually — see
[`python-service/README.md`](./python-service/README.md) for details.

> [!IMPORTANT]
> A free **TMDB API Key** is required for metadata, search, and posters.
> 1. Create a free account at [themoviedb.org](https://www.themoviedb.org/signup).
> 2. Generate an API Key (v3 API key or v4 Read Access Token) in [TMDB Settings > API](https://www.themoviedb.org/settings/api).
> 3. Paste it into `.env`: `TMDB_API_KEY=your_key_here`.

> [!IMPORTANT]
> If `SC_ADMIN_PASSWORD` in `.env` is empty, the service generates an admin
> password and prints it to the log **only once**, when the database is created.
> Save that password or set `SC_ADMIN_PASSWORD` before the first startup.

> [!NOTE]
> The Vixsrc playback domain can rotate over time (default: `vixsrc.to`). The domain
> can be changed from the admin panel in the website without restarting the service,
> and updates automatically via backend redirect checks.

## Configuration (.env files)

| Variable             | Default                            | Purpose                                                |
| -------------------- | ---------------------------------- | ------------------------------------------------------ |
| `TMDB_API_KEY`       | empty                              | TMDB API Key / Access Token (required for metadata)    |
| `SC_PORT`            | `8000`                             | Local port for the Python service                      |
| `SC_VIXSRC_DOMAIN`   | `vixsrc.to`                        | Initial/fallback playback and catalogue host (DB takes precedence once updated in `/admin`) |
| `SC_CACHE_TTL`       | `1800`                             | In-process response cache, in seconds (30m)            |
| `SC_LOG_LEVEL`       | `INFO`                             | Python service log level (`DEBUG` for more)            |
| `SC_DB_PATH`         | `python-service/data/streamapp.db` | Accounts, sessions, library and history                |
| `SC_ADMIN_NAME`      | `Admin`                            | Name of the first admin profile                        |
| `SC_ADMIN_PASSWORD`  | generated and logged               | Password for the first admin profile                   |
| `SC_SESSION_DAYS`    | `30`                               | How long a session token stays valid                   |
| `SC_LOCKOUT_MINUTES` | `15`                               | Lockout after five failed sign-ins                     |
| `SC_BASE_URL`        | empty                              | Public base URL used for profile picture links         |

> [!NOTE]
> `SC_VIXSRC_DOMAIN` in `.env` serves as the initial seed and fallback. When changed via the `/admin` UI or automatically via redirect detection, the active domain is stored in SQLite (`app_settings`) and overrides the `.env` value.

The root `.env.example` documents all service configuration variables.

## Accounts

Every page sits behind a Netflix-style profile picker at `/login`. On an empty
database the service seeds one admin — `SC_ADMIN_NAME` with `SC_ADMIN_PASSWORD`,
or a generated password printed once to its log — and only an admin can create
further profiles from `/admin`. Five wrong passwords lock a profile for
`SC_LOCKOUT_MINUTES`; an admin can unlock it early.

Accounts, sessions, saved titles and watch history all live in the SQLite file at
`SC_DB_PATH`, so back that file up and keep it out of the repository. `/library`
shows what the signed-in profile saved and recently played.

If you want to host the project, remember to set the variable `SC_BASE_URL` in `.env` for the profile pictures to
be reachable, because it will work as an API for the profile pictures. If you don't care 
about this, simply skip this and follow the standard process to deploy the project.

## Playback

The watch page is `/watch/<id>`, with `?s=<season>&e=<episode>` selecting the
episode for series. Playback is keyed by TMDB id and prefers a direct HLS
playlist over the iframe embed, resolved server-side by `GET /stream`:

1. `https://<playback-domain>/api/{movie,tv}/<tmdbId>[/<season>/<episode>]`
   returns the path of a token'd embed page.
2. That page is scraped for `window.masterPlaylist`, and its token — valid for
   roughly 60 days — is folded into a playlist URL the browser plays with
   `hls.js`.

Because only the playlist is fetched, the host's own page never loads and its ad
tag never runs. The embed token from step 1 expires in about two minutes, so both
steps run back to back inside the Python service.

When resolving fails, or the player hits an unrecoverable error, the watch page
falls back to the iframe embed:

- films — `https://<playback-domain>/movie/<tmdbId>`
- series — `https://<playback-domain>/tv/<tmdbId>/<season>/<episode>`

The Python service reports the active playback host at `GET /player`.

## Watch Together

The watch page includes a Watch Together mode for watching with other profiles.
Create a room from `/watch/<id>`, then share its room code or invite link. Other
participants can join the same movie or episode and receive synchronized play,
pause and seek events. Each room also includes a live chat, participant list and
host indicator. A room can be left at any time from the Watch Together dialog.

