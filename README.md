# StreamApp - Rdn

A web dashboard for browsing films and series — catalogue, ratings, seasons and
episodes — through the italian streamingcommunity service, backed by the
[`streamingcommunity-unofficialapi`](https://pypi.org/project/streamingcommunity-unofficialapi/)
Python library, with playback through an embedded player.

## Development

You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating) — plus Python 3.10+.

```sh
git clone <this-repository-url>
cd <repository-name>
cp .env.example .env
npm i
npm run dev
```

Copy `.env.example` to `.env` in the repository root and adjust the values for
your setup. `npm run dev` loads that file for both the Python service and Vite;
variables already exported in the shell take precedence.

`npm run dev` starts both the Python streaming API service and the Vite dev
server, and connects them automatically via `STREAMING_API_URL`. You can still
run the Python service manually — see
[`python-service/README.md`](./python-service/README.md) for details.

> [!IMPORTANT]
> If `SC_ADMIN_PASSWORD` in .env is empty, the service generates a
> password and prints it to the log **only once**, when the database is created.
> Save that password or set `SC_ADMIN_PASSWORD` before the first startup.

## Configuration (.env files)

| Variable             | Default                            | Purpose                                        |
| -------------------- | ---------------------------------- | ---------------------------------------------- |
| `SC_PORT`            | `8000`                             | Local port for the Python service              |
| `SC_CACHE_TTL`       | `600`                              | In-process response cache, in seconds          |
| `SC_LOG_LEVEL`       | `INFO`                             | Python service log level (`DEBUG` for more)    |
| `SC_DB_PATH`         | `python-service/data/streamapp.db` | Accounts, sessions, library and history        |
| `SC_ADMIN_NAME`      | `Admin`                            | Name of the first admin profile                |
| `SC_ADMIN_PASSWORD`  | generated and logged               | Password for the first admin profile           |
| `SC_SESSION_DAYS`    | `30`                               | How long a session token stays valid           |
| `SC_LOCKOUT_MINUTES` | `15`                               | Lockout after five failed sign-ins             |
| `SC_BASE_URL`        | empty                              | Public base URL used for profile picture links |

The catalogue and playback domains default to values in `python-service/main.py`
and can be changed from the admin panel without restarting the service.
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

Not every title resolves: the host has per-episode gaps, and its markup changes.
When resolving fails, or the player hits an unrecoverable error, the watch page
falls back to the iframe embed and says so:

- films — `https://<playback-domain>/movie/<tmdbId>`
- series — `https://<playback-domain>/tv/<tmdbId>/<season>/<episode>`

The Python service reports the active playback host at `GET /player`.

Embed hosts rotate and may serve content you are not licensed to view — keep the
host configurable rather than hardcoded, and check what you are pointing it at.

Watched time gets saved by using a clock that counts how many seconds/minutes you were watching
a tv show or a movie. Unluckily, due to vixsrc events not working properly, there isn't another way
to record resume time in a better way ;(( (or atleast not for me lol).
