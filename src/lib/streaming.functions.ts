import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { mockStats, mockTitles, toSummary } from "./streaming/mock";
import type {
  LibraryStats,
  PlayerConfig,
  StreamSource,
  TitleDetail,
  TitleSummary,
} from "./streaming/types";

/**
 * The `streamingcommunity-unofficialapi` package is Python-only, so it cannot run
 * inside this app's runtime. Point STREAMING_API_URL at a small Python service that
 * wraps the library and exposes:
 *   GET /search?q=...        -> TitleSummary[]
 *   GET /trending            -> TitleSummary[]
 *   GET /latest              -> TitleSummary[]
 *   GET /title/{id}          -> TitleDetail
 *   GET /stats               -> LibraryStats
 *   GET /player              -> PlayerConfig
 *   GET /stream              -> StreamSource
 * Until that URL is configured, the sample catalogue below is served instead.
 */
async function upstream<T>(path: string): Promise<T | null> {
  const base = process.env["STREAMING_API_URL"];
  if (!base) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const getSourceStatus = createServerFn({ method: "GET" }).handler(async () => ({
  live: Boolean(process.env["STREAMING_API_URL"]),
}));

export const getTrending = createServerFn({ method: "GET" }).handler(
  async (): Promise<TitleSummary[]> => {
    const live = await upstream<TitleSummary[]>("/trending");
    return live ?? [...mockTitles].sort((a, b) => b.score - a.score).map(toSummary);
  },
);

export const getLatest = createServerFn({ method: "GET" }).handler(
  async (): Promise<TitleSummary[]> => {
    const live = await upstream<TitleSummary[]>("/latest");
    return live ?? [...mockTitles].sort((a, b) => b.year - a.year).map(toSummary);
  },
);

export const getStats = createServerFn({ method: "GET" }).handler(
  async (): Promise<LibraryStats> => {
    const live = await upstream<LibraryStats>("/stats");
    return live ?? mockStats();
  },
);

export const searchTitles = createServerFn({ method: "GET" })
  .validator((data) => z.object({ query: z.string().max(120) }).parse(data))
  .handler(async ({ data }): Promise<TitleSummary[]> => {
    const q = data.query.trim();
    if (!q) return [];
    const live = await upstream<TitleSummary[]>(`/search?q=${encodeURIComponent(q)}`);
    if (live) return live;
    const needle = q.toLowerCase();
    return mockTitles
      .filter(
        (t) =>
          t.name.toLowerCase().includes(needle) ||
          t.genres.some((g) => g.toLowerCase().includes(needle)),
      )
      .map(toSummary);
  });

export const getTitle = createServerFn({ method: "GET" })
  .validator((data) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data }): Promise<TitleDetail | null> => {
    const live = await upstream<TitleDetail>(`/title/${encodeURIComponent(data.id)}`);
    if (live) return live;
    return mockTitles.find((t) => t.slug === data.id || String(t.id) === data.id) ?? null;
  });

export const getPlayerConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<PlayerConfig> => {
    const live = await upstream<PlayerConfig>("/player");
    if (live) return live;
    const domain = process.env["SC_VIXSRC_DOMAIN"] || "vixsrc.to";
    return { provider: "vixsrc", domain, enabled: Boolean(domain) };
  },
);

export const getStreamSource = createServerFn({ method: "GET" })
  .validator((data) =>
    z
      .object({
        tmdbId: z.number().int().positive(),
        type: z.enum(["movie", "tv"]),
        season: z.number().int().positive().optional(),
        episode: z.number().int().positive().optional(),
        lang: z.string().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<StreamSource | null> => {
    const query = new URLSearchParams({ tmdb: String(data.tmdbId), type: data.type });
    if (data.season) query.set("s", String(data.season));
    if (data.episode) query.set("e", String(data.episode));
    query.set("lang", data.lang || "it");
    const live = await upstream<StreamSource>(`/stream?${query}`);
    if (live) return live;
    return null;
  });
