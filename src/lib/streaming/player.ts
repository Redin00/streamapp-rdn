import type { PlayerConfig, TitleType } from "./types";

export interface EmbedTarget {
  tmdbId: number;
  type: TitleType;
  season?: number | undefined;
  episode?: number | undefined;
  startAt?: number | undefined;
  /** Set to true to bypass clean embed proxy and use raw Vixsrc host directly */
  raw?: boolean | undefined;
}

/**
 * Builds the embed URL for a title.
 * By default, returns the proxied and sanitized `/clean-embed` endpoint,
 * which strips intrusive ads, popup scripts, and anti-sandbox protections.
 *
 * Series need both a season and an episode number; TMDB numbering is used,
 * not the catalogue's internal episode ids.
 */
export function buildEmbedUrl(config: PlayerConfig, target: EmbedTarget): string | null {
  if (!config.enabled || !config.domain) return null;

  // Use clean embed proxy by default to prevent ad redirects and bypass sandbox checks
  if (!target.raw) {
    if (target.type === "tv" && (!target.season || !target.episode)) return null;

    const params = new URLSearchParams({
      tmdb: String(target.tmdbId),
      type: target.type,
    });
    if (target.season && target.episode) {
      params.set("s", String(target.season));
      params.set("e", String(target.episode));
    }
    if (target.startAt !== undefined && target.startAt > 0) {
      params.set("startAt", String(Math.floor(target.startAt)));
    }
    return `/clean-embed?${params.toString()}`;
  }

  const host = config.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");

  let path: string;
  if (target.type === "tv") {
    if (!target.season || !target.episode) return null;
    path = `/tv/${target.tmdbId}/${target.season}/${target.episode}`;
  } else {
    path = `/movie/${target.tmdbId}`;
  }

  const url = new URL(path, `https://${host}`);
  if (target.startAt !== undefined && target.startAt > 0) {
    url.searchParams.set("startAt", String(Math.floor(target.startAt)));
  }
  return url.toString();
}
