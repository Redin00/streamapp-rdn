"""SQLite storage for accounts, sessions, library and watch history.

The dashboard builds to Cloudflare, where there is no writable disk and no Node
sqlite, so every bit of state the app owns lives in this service instead.

Timestamps are integer unix milliseconds everywhere: second resolution made two
plays inside the same second tie in the history ordering, and milliseconds are
what the dashboard's `Date` and `date-fns` calls expect natively.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, Optional

log = logging.getLogger("streaming-dashboard")

# Module-relative so the database does not follow the process working directory.
DB_PATH = Path(os.environ.get("SC_DB_PATH") or Path(__file__).parent / "data" / "streamapp.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    color           TEXT NOT NULL DEFAULT '#6366f1',
    profile_picture TEXT,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    INTEGER,
    created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS library_items (
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    slug        TEXT NOT NULL,
    snapshot    TEXT NOT NULL,
    added_at    INTEGER NOT NULL,
    PRIMARY KEY (account_id, slug)
);

CREATE TABLE IF NOT EXISTS watch_history (
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    slug        TEXT NOT NULL,
    -- 0 rather than NULL: SQLite treats NULLs as distinct in a primary key, so
    -- a film would grow a new row on every play instead of upserting.
    season      INTEGER NOT NULL DEFAULT 0,
    episode     INTEGER NOT NULL DEFAULT 0,
    snapshot    TEXT NOT NULL,
    watched_at  INTEGER NOT NULL,
    -- Seconds watched in the most recent session for this slug/season/episode,
    -- or 0 when nothing has been recorded yet. The dashboard seeks to this
    -- position when playback starts and updates it as the user watches.
    marker      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, slug, season, episode)
);
CREATE INDEX IF NOT EXISTS history_account ON watch_history(account_id, watched_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalogue_cache (
    key         TEXT PRIMARY KEY,
    payload     TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);
"""


def now() -> int:
    """Current unix time in milliseconds — the unit every stored timestamp uses."""
    return int(time.time() * 1000)


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """One connection per request, committed on success and always closed.

    sqlite3 objects are not shareable across threads by default and FastAPI may
    run handlers on any worker thread, so nothing is pooled here.
    """
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        with conn:  # commit, or roll back if the block raises
            yield conn
    finally:
        conn.close()


def init_db() -> None:
    """Create the database file, switch it to WAL and apply the schema."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        # Persistent per file, so it only has to be set on the way in.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        # Migrations for fields added after the initial deploy: safe to re-run.
        try:
            conn.execute("ALTER TABLE accounts ADD COLUMN profile_picture TEXT")
        except sqlite3.OperationalError:
            pass  # column already present
        try:
            conn.execute("ALTER TABLE watch_history ADD COLUMN marker INTEGER NOT NULL DEFAULT 0")
        except sqlite3.OperationalError:
            pass  # column already present
    log.info("database ready at %s", DB_PATH)


def get_setting(key: str, default: str = "") -> str:
    with connect() as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return str(row["value"]) if row is not None else default


def set_setting(key: str, value: str) -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO app_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, value),
        )


def get_db_cache(key: str) -> Optional[tuple[float, Any]]:
    """Return (updated_at_seconds, payload_dict) if present in SQLite, else None."""
    with connect() as conn:
        row = conn.execute("SELECT payload, updated_at FROM catalogue_cache WHERE key = ?", (key,)).fetchone()
    if row is None:
        return None
    try:
        data = json.loads(row["payload"])
        return (float(row["updated_at"]) / 1000.0, data)
    except Exception:
        return None


def set_db_cache(key: str, data: Any) -> None:
    """Store cached catalogue payload into SQLite for persistent survival across restarts."""
    payload_str = json.dumps(data, ensure_ascii=False)
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO catalogue_cache (key, payload, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
            """,
            (key, payload_str, now()),
        )


def clear_db_cache() -> None:
    """Purge all cached catalogue payloads."""
    with connect() as conn:
        conn.execute("DELETE FROM catalogue_cache")


def _number(value: Any) -> Optional[float]:
    """Snapshot numbers only: bools pass `isinstance(x, int)` and must not count."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def clean_snapshot(raw: Any) -> str:
    """Normalise a client-sent title summary into a bounded JSON blob.

    Snapshots are stored verbatim and re-served to the library grid, so they are
    whitelisted by explicit construction and every string is length-bounded here
    rather than truncated after serialising (which would corrupt the JSON).
    """
    src = raw if isinstance(raw, dict) else {}

    def text(key: str, limit: int) -> str:
        value = src.get(key)
        return "" if value is None else str(value)[:limit]

    raw_genres = src.get("genres")
    genres = [str(g)[:60] for g in raw_genres[:8] if g] if isinstance(raw_genres, list) else []
    seasons_count = _number(src.get("seasonsCount"))

    snapshot: Dict[str, Any] = {
        "id": int(_number(src.get("id")) or 0),
        "slug": text("slug", 200),
        "name": text("name", 200),
        "type": src.get("type") if src.get("type") in ("movie", "tv") else "tv",
        "year": int(_number(src.get("year")) or 0),
        "score": round(_number(src.get("score")) or 0.0, 1),
        "posterUrl": text("posterUrl", 600),
        "backdropUrl": text("backdropUrl", 600),
        "genres": genres,
    }
    if seasons_count is not None:
        snapshot["seasonsCount"] = int(seasons_count)
    return json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False)


def parse_snapshot(text: str) -> Dict[str, Any]:
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}
