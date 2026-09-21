import type { PlayerConfig, TitleType } from "./types";

export interface EmbedTarget {
  tmdbId: number;
  type: TitleType;
  season?: number | undefined;
  episode?: number | undefined;
  startAt?: number | undefined;
}

/**
 * Builds the embed URL for a title. Series need both a season and an episode
 * number; TMDB numbering is used, not the catalogue's internal episode ids.
 */
export function buildEmbedUrl(config: PlayerConfig, target: EmbedTarget): string | null {
  if (!config.enabled || !config.domain) return null;

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
