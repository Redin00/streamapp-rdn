export type TitleType = "movie" | "tv";

export interface TitleSummary {
  id: number;
  slug: string;
  name: string;
  type: TitleType;
  year: number;
  score: number;
  posterUrl: string;
  backdropUrl: string;
  genres: string[];
  seasonsCount?: number | null | undefined;
}

export interface Episode {
  id: number;
  number: number;
  name: string;
  plot: string;
  duration: number;
}

export interface Season {
  number: number;
  name: string;
  episodes: Episode[];
}

export interface TitleDetail extends TitleSummary {
  plot: string;
  quality: string;
  runtime: number;
  status: string;
  cast: string[];
  trailerUrl?: string | undefined;
  tmdbId?: number | null | undefined;
  imdbId?: string | null | undefined;
  seasons: Season[];
}

/** Response of GET /player — the embed host used to build playback URLs. */
export interface PlayerConfig {
  provider: string;
  domain: string;
  enabled: boolean;
}

/**
 * Response of GET /stream — an HLS master playlist playable without the embed
 * iframe, so the host's page (and its ad tag) never loads.
 */
export interface StreamSource {
  provider: string;
  playlistUrl: string;
  /** Playlist token expiry, as a unix timestamp in seconds. */
  expiresAt: number;
  fhd: boolean;
}

export interface LibraryStats {
  totalTitles: number;
  movies: number;
  series: number;
  averageScore: number;
  genreBreakdown: { genre: string; count: number }[];
  weeklyViews: { day: string; views: number }[];
}
