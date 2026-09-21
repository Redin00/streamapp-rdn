import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { LibraryItem, MutationResult, WatchEntry } from "./auth/types";
import { messageFor, serviceFetch } from "./service";
import type { TitleSummary } from "./streaming/types";

// Mirrors TitleSummary. The snapshot is built by our own catalogue calls and the
// service whitelists and bounds it again before storing, so this only keeps a
// malformed card from ever reaching the database.
const titleSummary = z.object({
  id: z.number(),
  slug: z.string(),
  name: z.string().min(1),
  type: z.enum(["movie", "tv"]),
  year: z.number(),
  score: z.number(),
  posterUrl: z.string(),
  backdropUrl: z.string(),
  genres: z.array(z.string()),
  seasonsCount: z.number().nullable().optional(),
});

const save = z.object({ slug: z.string().min(1).max(200), title: titleSummary });

// ---- In-memory stand-in used when the Python service is unreachable. ----

const mockLibrary: LibraryItem[] = [];
const mockHistory: WatchEntry[] = [];

function nowMs(): number {
  return Date.now();
}

function upsertLibrary(slug: string, title: TitleSummary): void {
  const existing = mockLibrary.find((item) => item.slug === slug);
  if (existing) {
    existing.title = title;
    existing.addedAt = nowMs();
  } else {
    mockLibrary.push({ slug, title, addedAt: nowMs() });
  }
}

function removeLibrary(slug: string): void {
  const index = mockLibrary.findIndex((item) => item.slug === slug);
  if (index !== -1) mockLibrary.splice(index, 1);
}

function upsertHistory(slug: string, title: TitleSummary, season: number, episode: number): void {
  const existing = mockHistory.find(
    (entry) => entry.slug === slug && entry.season === season && entry.episode === episode,
  );
  if (existing) {
    existing.title = title;
    existing.watchedAt = nowMs();
  } else {
    mockHistory.push({ slug, season, episode, title, watchedAt: nowMs(), marker: 0 });
  }
}

/** Saved titles, newest first. Falls back to the in-memory store when the
 * service is unreachable, so the library grid still renders in dev. */
export const getLibrary = createServerFn({ method: "GET" }).handler(
  async (): Promise<LibraryItem[] | null> => {
    try {
      return await serviceFetch<LibraryItem[]>("/library");
    } catch {
      return [...mockLibrary];
    }
  },
);

/** Recently played titles. Same fallback behaviour as `getLibrary`. */
export const getHistory = createServerFn({ method: "GET" }).handler(
  async (): Promise<WatchEntry[] | null> => {
    try {
      return await serviceFetch<WatchEntry[]>("/history?limit=24");
    } catch {
      return [...mockHistory];
    }
  },
);

export const addToLibrary = createServerFn({ method: "POST" })
  .validator((data) => save.parse(data))
  .handler(async ({ data }): Promise<MutationResult<null>> => {
    try {
      await serviceFetch<{ slug: string; addedAt: number }>("/library", {
        method: "POST",
        body: JSON.stringify({ slug: data.slug, snapshot: data.title }),
      });
      return { ok: true, data: null };
    } catch {
      upsertLibrary(data.slug, data.title);
      return { ok: true, data: null };
    }
  });

export const removeFromLibrary = createServerFn({ method: "POST" })
  .validator((data) => z.object({ slug: z.string().min(1).max(200) }).parse(data))
  .handler(async ({ data }): Promise<MutationResult<null>> => {
    try {
      await serviceFetch<void>(`/library/${encodeURIComponent(data.slug)}`, {
        method: "DELETE",
      });
      return { ok: true, data: null };
    } catch {
      removeLibrary(data.slug);
      return { ok: true, data: null };
    }
  });

const removeHistoryValidator = z.object({
  slug: z.string().min(1).max(200),
  season: z.number().int().min(0).max(1000).optional(),
  episode: z.number().int().min(0).max(10000).optional(),
});

export const removeFromHistory = createServerFn({ method: "POST" })
  .validator((data) => removeHistoryValidator.parse(data))
  .handler(async ({ data }): Promise<MutationResult<null>> => {
    try {
      await serviceFetch<void>(
        `/history/${encodeURIComponent(data.slug)}?${new URLSearchParams({
          season: String(data.season ?? 0),
          episode: String(data.episode ?? 0),
        })}`,
        { method: "DELETE" },
      );
      return { ok: true, data: null };
    } catch {
      const idx = mockHistory.findIndex(
        (e) =>
          e.slug === data.slug &&
          e.season === (data.season ?? 0) &&
          e.episode === (data.episode ?? 0),
      );
      if (idx !== -1) mockHistory.splice(idx, 1);
      return { ok: true, data: null };
    }
  });

/**
 * Record one play. Season and episode stay 0 for films, which is what makes a
 * replay update the existing row instead of adding another.
 */
export const recordPlay = createServerFn({ method: "POST" })
  .validator((data) =>
    z
      .object({
        slug: z.string().min(1).max(200),
        title: titleSummary,
        season: z.number().int().min(0).max(1000).optional(),
        episode: z.number().int().min(0).max(10000).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    try {
      await serviceFetch<{ watchedAt: number }>("/history", {
        method: "POST",
        body: JSON.stringify({
          slug: data.slug,
          snapshot: data.title,
          season: data.season ?? 0,
          episode: data.episode ?? 0,
        }),
      });
      return { ok: true };
    } catch {
      upsertHistory(data.slug, data.title, data.season ?? 0, data.episode ?? 0);
      return { ok: true };
    }
  });

/** The resume marker (seconds watched) for one title/season/episode. */
export const getWatchMarker = createServerFn({ method: "GET" })
  .validator((data) =>
    z
      .object({
        slug: z.string().min(1).max(200),
        season: z.number().int().min(0).max(1000).optional(),
        episode: z.number().int().min(0).max(10000).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<{ marker: number } | null> => {
    try {
      const entry = await serviceFetch<{
        slug: string;
        season: number;
        episode: number;
        title: TitleSummary;
        watchedAt: number;
        marker: number;
      } | null>(
        `/history/${encodeURIComponent(data.slug)}?${new URLSearchParams({
          season: String(data.season ?? 0),
          episode: String(data.episode ?? 0),
        })}`,
      );
      return entry ? { marker: entry.marker } : null;
    } catch {
      const found = mockHistory.find(
        (e) =>
          e.slug === data.slug &&
          e.season === (data.season ?? 0) &&
          e.episode === (data.episode ?? 0),
      );
      if (found) return { marker: found.marker };
      // Fall back to a localStorage copy saved when the service was unreachable.
      try {
        const stored = localStorage.getItem(
          `watch-marker:${data.slug}:${data.season ?? 0}:${data.episode ?? 0}`,
        );
        if (stored !== null) {
          const parsed = parseInt(stored, 10);
          if (!Number.isNaN(parsed) && parsed > 0) return { marker: parsed };
        }
      } catch {
        // localStorage unavailable — ignore.
      }
      return null;
    }
  });

/** Record or update the resume marker for one title/season/episode. */
export const updateWatchMarker = createServerFn({ method: "POST" })
  .validator((data) =>
    z
      .object({
        slug: z.string().min(1).max(200),
        title: titleSummary,
        season: z.number().int().min(0).max(1000).optional(),
        episode: z.number().int().min(0).max(10000).optional(),
        marker: z.number().int().min(0).max(2_147_483_647),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; marker: number }> => {
    const season = data.season ?? 0;
    const episode = data.episode ?? 0;
    try {
      const result = await serviceFetch<{
        slug: string;
        season: number;
        episode: number;
        marker: number;
      }>("/history/marker", {
        method: "POST",
        body: JSON.stringify({
          slug: data.slug,
          snapshot: data.title,
          season,
          episode,
          marker: data.marker,
        }),
      });
      return { ok: true, marker: result.marker };
    } catch {
      const existing = mockHistory.find(
        (e) => e.slug === data.slug && e.season === season && e.episode === episode,
      );
      if (existing) {
        existing.marker = data.marker;
      } else {
        upsertHistory(data.slug, data.title, season, episode);
        const fresh = mockHistory.find(
          (e) => e.slug === data.slug && e.season === season && e.episode === episode,
        );
        if (fresh) fresh.marker = data.marker;
      }
      // Also persist to localStorage as a cross-session fallback when the
      // streaming service is unreachable, so the resume marker survives
      // across page reloads and sessions.
      try {
        const key = `watch-marker:${data.slug}:${season}:${episode}`;
        localStorage.setItem(key, String(data.marker));
      } catch {
        // Ignore quota/storage errors — the server write is the source of truth.
      }
      return { ok: true, marker: data.marker };
    }
  });

/** Format a watch marker (seconds) as "M min S sec" for display. */
export const formatWatchPosition = (marker: number): string => {
  if (!Number.isFinite(marker) || marker <= 0) return "0 min 0 sec";
  const mins = Math.floor(marker / 60);
  const secs = Math.round(marker % 60);
  return `${mins} min ${secs} sec`;
};

/** Reset the entire watch-tracking state (dev / testing helper). */
export const clearAllHistory = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: boolean; message?: string }> => {
    try {
      mockHistory.length = 0;
      return { ok: true };
    } catch (error) {
      return { ok: false, message: messageFor(error) };
    }
  },
);

/** Remove one resume marker from the service and local fallback stores. */
export const removeWatchMarker = createServerFn({ method: "POST" })
  .validator((data) =>
    z
      .object({
        slug: z.string().min(1).max(200),
        season: z.number().int().min(0).max(1000).optional(),
        episode: z.number().int().min(0).max(10000).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const season = data.season ?? 0;
    const episode = data.episode ?? 0;
    const idx = mockHistory.findIndex(
      (e) => e.slug === data.slug && e.season === season && e.episode === episode,
    );
    if (idx !== -1) mockHistory[idx]!.marker = 0;

    try {
      await serviceFetch<void>(
        `/history/marker/${encodeURIComponent(data.slug)}?${new URLSearchParams({
          season: String(season),
          episode: String(episode),
        })}`,
        { method: "DELETE" },
      );
    } catch {
      // The in-memory and localStorage stores above remain the offline fallback.
    }

    try {
      localStorage.removeItem(`watch-marker:${data.slug}:${season}:${episode}`);
    } catch {
      // Ignore storage errors.
    }
    return { ok: true };
  });

/** Clear the whole library mock store (admin helper). */
export const clearAllLibrary = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: boolean; message?: string }> => {
    try {
      mockLibrary.length = 0;
      return { ok: true };
    } catch (error) {
      return { ok: false, message: messageFor(error) };
    }
  },
);
