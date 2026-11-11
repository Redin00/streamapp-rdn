import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { queryOptions, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, ChevronDown, Languages, Loader2, Maximize, Minimize, Pause, Play, RotateCcw, Users } from "lucide-react";
import { z } from "zod";

import { HlsPlayer, type HlsPlayerHandle } from "@/components/HlsPlayer";
import { AdBlockPrompt, useAdBlockPrompt } from "@/components/AdBlockPrompt";
import { WatchTogetherDialog } from "@/components/WatchTogetherDialog";
import { ScrollableRow } from "@/components/ScrollableRow";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useBrowserInfo } from "@/hooks/use-browser-info";
import { historyQuery } from "@/lib/auth/queries";
import type { WatchEntry } from "@/lib/auth/types";
import {
  getWatchMarker,
  recordPlay,
  updateWatchMarker,
} from "@/lib/library.functions";
import { getOrCreateGuestId, useWatchParty } from "@/lib/party/party-client";
import { createPartyRoom, getPartyRoom } from "@/lib/party/party.functions";
import type { PartyMedia } from "@/lib/party/types";
import { getPlayerConfig, getStreamSource, getTitle } from "@/lib/streaming.functions";
import { buildEmbedUrl } from "@/lib/streaming/player";
import { useTranslation } from "@/lib/i18n-hook";

const titleQuery = (id: string) =>
  queryOptions({
    queryKey: ["title", id],
    queryFn: () => getTitle({ data: { id } }),
  });

const playerQuery = queryOptions({
  queryKey: ["player-config"],
  queryFn: () => getPlayerConfig(),
});

interface PlayerEventData {
  event?: string | undefined;
  currentTime?: number | undefined;
  duration?: number | undefined;
  time?: number | undefined;
  seconds?: number | undefined;
  position?: number | undefined;
  offset?: number | undefined;
  value?: number | undefined;
  video_id?: string | undefined;
}

interface PlayerMessagePayload {
  type?: string | undefined;
  event?: PlayerEventData | string | undefined;
  data?: PlayerEventData | undefined;
  info?: PlayerEventData | undefined;
  payload?: PlayerEventData | undefined;
  currentTime?: number | undefined;
  duration?: number | undefined;
  time?: number | undefined;
  seconds?: number | undefined;
  position?: number | undefined;
  value?: number | undefined;
}


export const Route = createFileRoute("/_auth/watch/$id")({
  validateSearch: (search: Record<string, unknown>) => {
    const parsed = z
      .object({
        s: z.coerce.number().int().positive().optional(),
        e: z.coerce.number().int().positive().optional(),
        party: z.string().optional(),
      })
      .safeParse(search);
    return parsed.success ? parsed.data : {};
  },
  loader: async ({ context, params }) => {
    const [title] = await Promise.all([
      context.queryClient.ensureQueryData(titleQuery(params.id)),
      context.queryClient.ensureQueryData(playerQuery),
    ]);
    if (!title) throw notFound();
    return { name: title.name };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `Watch ${loaderData.name} - StreamApp - Rdn`
          : "Watch - StreamApp - Rdn",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: WatchPage,
});

function WatchPage() {
  const { id } = Route.useParams();
  const { s, e, party: searchPartyCode } = Route.useSearch();
  const { viewer } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const { data: title } = useSuspenseQuery(titleQuery(id));
  const { data: player } = useSuspenseQuery(playerQuery);
  const { t, locale } = useTranslation();

  const isSeries = title?.type === "tv";
  const activeSeason = isSeries
    ? (title?.seasons.find((x) => x.number === s) ?? title?.seasons[0])
    : undefined;
  const activeEpisode = isSeries
    ? (activeSeason?.episodes.find((x) => x.number === e) ?? activeSeason?.episodes[0])
    : undefined;

  const nextEpisode = useMemo(() => {
    if (!activeSeason || !activeEpisode) return null;
    const currentIndex = activeSeason.episodes.findIndex(
      (ep) => ep.number === activeEpisode.number,
    );
    if (currentIndex >= 0 && currentIndex < activeSeason.episodes.length - 1) {
      const nextEp = activeSeason.episodes[currentIndex + 1];
      if (nextEp) {
        return {
          seasonNumber: activeSeason.number,
          episodeNumber: nextEp.number,
          name: nextEp.name,
        };
      }
    }
    if (title && title.seasons) {
      const currentSeasonIndex = title.seasons.findIndex(
        (sn) => sn.number === activeSeason.number,
      );
      if (currentSeasonIndex >= 0 && currentSeasonIndex < title.seasons.length - 1) {
        const nextSeason = title.seasons[currentSeasonIndex + 1];
        if (nextSeason && nextSeason.episodes && nextSeason.episodes.length > 0) {
          const firstEp = nextSeason.episodes[0];
          if (firstEp) {
            return {
              seasonNumber: nextSeason.number,
              episodeNumber: firstEp.number,
              name: firstEp.name,
            };
          }
        }
      }
    }
    return null;
  }, [title, activeSeason, activeEpisode]);

  const [hlsFailed, setHlsFailed] = useState(false);
  useEffect(() => setHlsFailed(false), [id, s, e]);

  const { browser: detectedBrowser, adblockActive } = useBrowserInfo();
  const adBlockPrompt = useAdBlockPrompt({ browser: detectedBrowser, adblockActive });

  // Default audio language automatically follows the site's selected language (it/en)
  const siteLang = locale === "en" ? "en" : "it";
  const [selectedLang, setSelectedLang] = useState<string>(siteLang);
  const partyLangRef = useRef<string>(siteLang);

  const embedUrl = title?.tmdbId
    ? buildEmbedUrl(player, {
        tmdbId: title.tmdbId,
        type: title.type,
        season: activeSeason?.number,
        episode: activeEpisode?.number,
        lang: selectedLang,
      })
    : null;

  const streamQuery = useQuery({
    queryKey: ["stream", title?.tmdbId, title?.type, activeSeason?.number, activeEpisode?.number, selectedLang],
    queryFn: () => {
      if (!title?.tmdbId) return null;
      return getStreamSource({
        data: {
          tmdbId: title.tmdbId,
          type: title.type,
          season: activeSeason?.number,
          episode: activeEpisode?.number,
          lang: selectedLang,
        },
      });
    },
    enabled: Boolean(title?.tmdbId && !embedUrl),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const playlistUrl = !embedUrl ? (streamQuery.data?.playlistUrl ?? null) : null;

  // --- resume position ---

  const [marker, setMarker] = useState<number | null>(null);
  const [markerLoaded, setMarkerLoaded] = useState(false);
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playLoggedRef = useRef(false);
  const latestSecondsRef = useRef<number | null>(null);

  const playbackDurationSeconds = (activeEpisode?.duration || title?.runtime || 0) * 60;

  const slug = title?.slug ?? "";
  const season = activeSeason?.number ?? 0;
  const episode = activeEpisode?.number ?? 0;

  function clearCompletedMarker() {
    setMarker(null);
    queryClient.setQueryData<WatchEntry[] | null>(
      historyQuery.queryKey,
      (current) =>
        current?.map((entry) =>
          entry.slug === slug && entry.season === season && entry.episode === episode
            ? { ...entry, marker: 0 }
            : entry,
        ) ?? null,
    );
  }

  // Check search param first
  const [partyCode, setPartyCode] = useState<string | null>(() => {
    if (searchPartyCode) return searchPartyCode.trim().toUpperCase();
    return null;
  });
  const [isCreatingParty, setIsCreatingParty] = useState(false);
  const [partyDialogOpen, setPartyDialogOpen] = useState(Boolean(searchPartyCode));
  const [isLocalPlaying, setIsLocalPlaying] = useState(false);
  const isLocalPlayingRef = useRef(isLocalPlaying);
  const isRoomPausedRef = useRef(false);
  const [isPausedByRemote, setIsPausedByRemote] = useState(false);
  const isPausedByRemoteRef = useRef(false);
  const [isEnded, setIsEnded] = useState(false);
  const isEndedRef = useRef(false);
  const remoteSeekDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localSeekDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localPlayDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pauseDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSeekEventAtRef = useRef<number>(0);
  const lastSeekActivityAtRef = useRef<number>(0);
  const lastKnownDurationRef = useRef<number>(0);
  useEffect(() => {
    isLocalPlayingRef.current = isLocalPlaying;
  }, [isLocalPlaying]);
  useEffect(() => {
    isPausedByRemoteRef.current = isPausedByRemote;
  }, [isPausedByRemote]);

  const [vixsrcEmbedUrl, setVixsrcEmbedUrl] = useState<string | null>(null);
  // Incremented to force the iframe to fully remount when remote sync requires a reload
  const [vixsrcIframeKey, setVixsrcIframeKey] = useState(0);
  const REMOTE_SUPPRESS_MS = 500; // ms, covers unloading previous iframe teardown during remote sync

  const hlsPlayerRef = useRef<HlsPlayerHandle>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isCssFullscreen, setIsCssFullscreen] = useState(false);
  const [isUserActive, setIsUserActive] = useState(true);
  const isUserActiveRef = useRef(true);
  const userActivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleFullscreen = useCallback(async () => {
    try {
      const doc = document as Document & {
        webkitFullscreenElement?: Element | null;
        webkitExitFullscreen?: () => Promise<void> | void;
      };
      const container = playerContainerRef.current as (HTMLDivElement & {
        webkitRequestFullscreen?: () => Promise<void> | void;
      }) | null;

      if (isCssFullscreen) {
        setIsCssFullscreen(false);
        setIsFullscreen(false);
        return;
      }

      const activeFs = document.fullscreenElement || doc.webkitFullscreenElement;
      if (!activeFs) {
        if (container?.requestFullscreen) {
          await container.requestFullscreen();
        } else if (container?.webkitRequestFullscreen) {
          await container.webkitRequestFullscreen();
        } else {
          // iOS iPhone fallback where Fullscreen API on div is not supported
          setIsCssFullscreen(true);
          setIsFullscreen(true);
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (doc.webkitExitFullscreen) {
          await doc.webkitExitFullscreen();
        }
      }
    } catch {
      // Fallback to CSS fullscreen on mobile browsers that reject requestFullscreen
      setIsCssFullscreen((prev) => {
        const next = !prev;
        setIsFullscreen(next);
        return next;
      });
    }
  }, [isCssFullscreen]);

  const handleUserActivity = useCallback(() => {
    if (!isUserActiveRef.current) {
      isUserActiveRef.current = true;
      setIsUserActive(true);
    }
    if (userActivityTimerRef.current) {
      clearTimeout(userActivityTimerRef.current);
    }
    if (isFullscreen) {
      userActivityTimerRef.current = setTimeout(() => {
        isUserActiveRef.current = false;
        setIsUserActive(false);
      }, 2500);
    }
  }, [isFullscreen]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      if (!active) {
        isUserActiveRef.current = true;
        setIsUserActive(true);
        if (userActivityTimerRef.current) {
          clearTimeout(userActivityTimerRef.current);
          userActivityTimerRef.current = null;
        }
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!isFullscreen) {
      isUserActiveRef.current = true;
      setIsUserActive(true);
      if (userActivityTimerRef.current) {
        clearTimeout(userActivityTimerRef.current);
        userActivityTimerRef.current = null;
      }
      return;
    }

    // Entering fullscreen: show controls initially and start inactivity countdown
    handleUserActivity();

    const onGlobalActivity = () => {
      handleUserActivity();
    };

    window.addEventListener("mousemove", onGlobalActivity, { passive: true });
    window.addEventListener("pointermove", onGlobalActivity, { passive: true });
    window.addEventListener("keydown", onGlobalActivity, { passive: true });
    window.addEventListener("touchstart", onGlobalActivity, { passive: true });

    return () => {
      window.removeEventListener("mousemove", onGlobalActivity);
      window.removeEventListener("pointermove", onGlobalActivity);
      window.removeEventListener("keydown", onGlobalActivity);
      window.removeEventListener("touchstart", onGlobalActivity);
      if (userActivityTimerRef.current) {
        clearTimeout(userActivityTimerRef.current);
        userActivityTimerRef.current = null;
      }
    };
  }, [isFullscreen, handleUserActivity]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const isInput =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active?.getAttribute("contenteditable") === "true";
      if (isInput) return;

      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        void toggleFullscreen();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleFullscreen]);

  const lastBroadcastMediaRef = useRef<string>("");
  // Timestamp of the last remote-triggered iframe reload (ms). Events fired by the
  // newly loaded player within REMOTE_SUPPRESS_MS of this timestamp will not be re-broadcast.
  const remoteActionRef = useRef<{ type: string | null; ts: number }>({ type: null, ts: 0 });
  const lastRemoteReloadRef = useRef<number>(0);

  // Tracks startup state of the currently mounted Vixsrc iframe so startup play/seek/pause
  // events (even after a 3-6s 2-stage load or browser autoplay block) never trigger echo loops
  const iframeStartupRef = useRef<{
    key: number;
    mountedAt: number;
    targetTime: number;
    expectedAutoplay: boolean;
    hasStartedPlaying: boolean;
    playingSince: number;
  }>({
    key: 0,
    mountedAt: 0,
    targetTime: 0,
    expectedAutoplay: false,
    hasStartedPlaying: false,
    playingSince: 0,
  });

  const lastReloadMetaRef = useRef<{
    mediaKey: string;
    targetTime: number;
    autoplay: boolean;
    lang: string;
    ts: number;
  } | null>(null);

  // Helper to safely re-generate the iframe embed URL and remount the iframe for Vixsrc
  const reloadVixsrc = useCallback(
    (startAt?: number, autoplay?: boolean, forcedLang?: string, isRemoteTriggered = false) => {
      if (!title?.tmdbId || !player) return;
      const numericStart =
        typeof startAt === "number" && Number.isFinite(startAt) && startAt >= 0
          ? Math.floor(startAt)
          : undefined;
      // In Vixsrc (vixsrc-1BuQSlV5.js), on("ready") runs:
      //   const e = a.get("startAt"); e ? n.seek(parseInt(e)) : n.play(!1);
      // If startAt is omitted, Vixsrc calls n.play(false) which pauses the player.
      // Passing startAt >= 1 when autoplay=true forces Vixsrc to seek and play.
      const effectiveStartAt =
        autoplay === true
          ? Math.max(1, numericStart ?? 1)
          : numericStart;
      const langToUse = forcedLang || selectedLang || (locale === "en" ? "en" : "it");
      const mediaKey = `${title.tmdbId}:${activeSeason?.number ?? 0}:${activeEpisode?.number ?? 0}`;
      const now = Date.now();

      // Deduplicate rapid identical reloads (e.g. initial room load + poll arriving 100ms apart)
      const prevMeta = lastReloadMetaRef.current;
      if (
        prevMeta &&
        prevMeta.mediaKey === mediaKey &&
        prevMeta.lang === langToUse &&
        prevMeta.autoplay === Boolean(autoplay) &&
        Math.abs(prevMeta.targetTime - (numericStart ?? 0)) <= 2 &&
        now - prevMeta.ts < 2200
      ) {
        return;
      }

      const nextUrl = buildEmbedUrl(player, {
        tmdbId: title.tmdbId,
        type: title.type,
        season: activeSeason?.number,
        episode: activeEpisode?.number,
        startAt: effectiveStartAt,
        autoplay,
        lang: langToUse,
      });
      if (nextUrl) {
        lastRemoteReloadRef.current = isRemoteTriggered ? now : 0;
        lastReloadMetaRef.current = {
          mediaKey,
          targetTime: numericStart ?? 0,
          autoplay: Boolean(autoplay),
          lang: langToUse,
          ts: now,
        };
        if (numericStart !== undefined) {
          latestSecondsRef.current = numericStart;
        }
        setVixsrcEmbedUrl(nextUrl);
        setVixsrcIframeKey((k) => {
          const nextKey = k + 1;
          iframeStartupRef.current = {
            key: nextKey,
            mountedAt: now,
            targetTime: numericStart ?? 0,
            expectedAutoplay: Boolean(autoplay),
            hasStartedPlaying: false,
            playingSince: 0,
          };
          return nextKey;
        });
      }
    },
    [title, player, activeSeason?.number, activeEpisode?.number, selectedLang, locale],
  );

  const isLeavingPartyRef = useRef(false);

  useEffect(() => {
    if (isLeavingPartyRef.current) {
      if (!searchPartyCode) {
        isLeavingPartyRef.current = false;
      }
      return;
    }
    if (searchPartyCode) {
      const clean = searchPartyCode.trim().toUpperCase();
      if (clean !== partyCode) {
        setPartyCode(clean);
      }
      try {
        sessionStorage.setItem("cinemagic_watch_party", clean);
      } catch {}
    }
  }, [searchPartyCode, partyCode]);

  useEffect(() => {
    if (partyCode) {
      try {
        sessionStorage.setItem("cinemagic_watch_party", partyCode);
      } catch {}
    }
  }, [partyCode]);

  const onRemotePlay = useCallback(
    (time: number, _isSyncTick = false) => {
      if (pauseDebounceRef.current) {
        clearTimeout(pauseDebounceRef.current);
        pauseDebounceRef.current = null;
      }
      if (localSeekDebounceRef.current) {
        clearTimeout(localSeekDebounceRef.current);
        localSeekDebounceRef.current = null;
      }
      if (localPlayDebounceRef.current) {
        clearTimeout(localPlayDebounceRef.current);
        localPlayDebounceRef.current = null;
      }
      const wasPaused =
        isRoomPausedRef.current || isPausedByRemoteRef.current || !isLocalPlayingRef.current;
      isRoomPausedRef.current = false;
      setIsPausedByRemote(false);
      isPausedByRemoteRef.current = false;
      setIsEnded(false);
      isEndedRef.current = false;
      if (playlistUrl && !hlsFailed) {
        setIsLocalPlaying(true);
        isLocalPlayingRef.current = true;
        latestSecondsRef.current = time;
        remoteActionRef.current = { type: "play", ts: Date.now() };
        const cur = hlsPlayerRef.current?.getCurrentTime() ?? 0;
        if (Math.abs(cur - time) > 2.0) {
          hlsPlayerRef.current?.seek(time);
        }
        hlsPlayerRef.current?.play();
      } else {
        const cur = latestSecondsRef.current ?? 0;
        setIsLocalPlaying(true);
        isLocalPlayingRef.current = true;
        remoteActionRef.current = { type: "play", ts: Date.now() };
        latestSecondsRef.current = time;

        if (wasPaused) {
          lastReloadMetaRef.current = null;
          reloadVixsrc(time, true, undefined, true);
        } else if (Math.abs(cur - time) > 3.0) {
          reloadVixsrc(time, true, undefined, true);
        }
      }
    },
    [playlistUrl, hlsFailed, reloadVixsrc],
  );

  const onRemotePause = useCallback(
    (time: number) => {
      if (pauseDebounceRef.current) {
        clearTimeout(pauseDebounceRef.current);
        pauseDebounceRef.current = null;
      }
      if (remoteSeekDebounceRef.current) {
        clearTimeout(remoteSeekDebounceRef.current);
        remoteSeekDebounceRef.current = null;
      }
      if (localSeekDebounceRef.current) {
        clearTimeout(localSeekDebounceRef.current);
        localSeekDebounceRef.current = null;
      }
      if (localPlayDebounceRef.current) {
        clearTimeout(localPlayDebounceRef.current);
        localPlayDebounceRef.current = null;
      }
      pendingSeekEventAtRef.current = 0;
      lastReloadMetaRef.current = null;
      isRoomPausedRef.current = true;
      setIsPausedByRemote(true);
      isPausedByRemoteRef.current = true;
      setIsLocalPlaying(false);
      isLocalPlayingRef.current = false;
      latestSecondsRef.current = time;
      remoteActionRef.current = { type: "pause", ts: Date.now() };
      if (playlistUrl && !hlsFailed) {
        hlsPlayerRef.current?.pause();
        const cur = hlsPlayerRef.current?.getCurrentTime() ?? 0;
        if (Math.abs(cur - time) > 1.5) {
          hlsPlayerRef.current?.seek(time);
        }
      }
    },
    [playlistUrl, hlsFailed],
  );

  const onRemoteSeek = useCallback(
    (time: number) => {
      if (!Number.isFinite(time) || time < 0) return;
      if (pauseDebounceRef.current) {
        clearTimeout(pauseDebounceRef.current);
        pauseDebounceRef.current = null;
      }
      if (localSeekDebounceRef.current) {
        clearTimeout(localSeekDebounceRef.current);
        localSeekDebounceRef.current = null;
      }
      if (localPlayDebounceRef.current) {
        clearTimeout(localPlayDebounceRef.current);
        localPlayDebounceRef.current = null;
      }
      pendingSeekEventAtRef.current = 0;
      latestSecondsRef.current = time;
      setIsEnded(false);
      isEndedRef.current = false;
      remoteActionRef.current = { type: "seek", ts: Date.now() };
      if (playlistUrl && !hlsFailed) {
        hlsPlayerRef.current?.seek(time);
      } else {
        if (remoteSeekDebounceRef.current) {
          clearTimeout(remoteSeekDebounceRef.current);
        }
        remoteSeekDebounceRef.current = setTimeout(() => {
          remoteSeekDebounceRef.current = null;
          if (!isPausedByRemoteRef.current) {
            reloadVixsrc(time, !isRoomPausedRef.current, undefined, true);
          }
        }, 180);
      }
    },
    [playlistUrl, hlsFailed, reloadVixsrc],
  );

  const onRemoteMediaChange = useCallback(
    (media: PartyMedia, roomCode?: string) => {
      const isDifferentSlug = Boolean(media.slug && media.slug !== slug);
      const targetSeason = media.type === "tv" ? (media.season ?? 1) : undefined;
      const targetEpisode = media.type === "tv" ? (media.episode ?? 1) : undefined;
      const currentSeason = activeSeason?.number;
      const currentEpisode = activeEpisode?.number;

      const isDifferentEpisode =
        media.type === "tv" &&
        (targetSeason !== currentSeason || targetEpisode !== currentEpisode);

      if (isDifferentSlug || isDifferentEpisode) {
        latestSecondsRef.current = 0;
        setIsEnded(false);
        isEndedRef.current = false;
        const code = (roomCode || partyCode || searchPartyCode || "").trim().toUpperCase();
        if (code) {
          try {
            sessionStorage.setItem("cinemagic_watch_party", code);
          } catch {}
        }
        void navigate({
          to: "/watch/$id",
          params: { id: media.slug },
          search: {
            s: targetSeason,
            e: targetEpisode,
            party: code || undefined,
          },
        });
        return;
      }

      if (media.lang && media.lang !== selectedLang) {
        partyLangRef.current = media.lang;
        setSelectedLang(media.lang);
        const cur = latestSecondsRef.current ?? 0;
        reloadVixsrc(cur > 0 ? cur : undefined, isLocalPlayingRef.current, media.lang, true);
      }
    },
    [slug, activeSeason, activeEpisode, navigate, partyCode, searchPartyCode, selectedLang, reloadVixsrc],
  );

  const getCurrentTime = useCallback(() => {
    if (playlistUrl && !hlsFailed && hlsPlayerRef.current) {
      return hlsPlayerRef.current.getCurrentTime();
    }
    return latestSecondsRef.current ?? 0;
  }, [playlistUrl, hlsFailed]);

  const getIsPlaying = useCallback(() => {
    if (playlistUrl && !hlsFailed && hlsPlayerRef.current) {
      return hlsPlayerRef.current.getIsPlaying();
    }
    return isLocalPlayingRef.current;
  }, [playlistUrl, hlsFailed]);

  const onRoomNotFound = useCallback(() => {
    setPartyCode(null);
    isRoomPausedRef.current = false;
    setIsPausedByRemote(false);
    isPausedByRemoteRef.current = false;
    setIsEnded(false);
    isEndedRef.current = false;
    try {
      sessionStorage.removeItem("cinemagic_watch_party");
    } catch {}
    void navigate({
      to: "/watch/$id",
      params: { id },
      search: {
        s: activeSeason?.number,
        e: activeEpisode?.number,
        party: undefined,
      },
      replace: true,
    });
  }, [id, activeSeason?.number, activeEpisode?.number, navigate]);

  const party = useWatchParty({
    roomCode: partyCode,
    viewer,
    onRemotePlay,
    onRemotePause,
    onRemoteSeek,
    onRemoteMediaChange,
    onRoomNotFound,
    getCurrentTime,
    getIsPlaying,
  });
  const partyRef = useRef(party);
  partyRef.current = party;

  const isRoomMatchingMedia = Boolean(
    party.room?.media &&
      party.room.media.slug === slug &&
      (party.room.media.type !== "tv" ||
        ((party.room.media.season ?? 1) === (activeSeason?.number ?? 1) &&
          (party.room.media.episode ?? 1) === (activeEpisode?.number ?? 1))),
  );

  const currentMediaKey = `${slug}:${season}:${episode}`;
  const activeMediaKeyRef = useRef(currentMediaKey);
  useEffect(() => {
    if (activeMediaKeyRef.current !== currentMediaKey) {
      activeMediaKeyRef.current = currentMediaKey;
      latestSecondsRef.current = 0;
      lastKnownDurationRef.current = 0;
      lastReloadMetaRef.current = null;
      lastRemoteReloadRef.current = 0;
      pendingSeekEventAtRef.current = 0;
      lastSeekActivityAtRef.current = 0;
      if (pauseDebounceRef.current) {
        clearTimeout(pauseDebounceRef.current);
        pauseDebounceRef.current = null;
      }
      if (localSeekDebounceRef.current) {
        clearTimeout(localSeekDebounceRef.current);
        localSeekDebounceRef.current = null;
      }
      if (localPlayDebounceRef.current) {
        clearTimeout(localPlayDebounceRef.current);
        localPlayDebounceRef.current = null;
      }
      setIsEnded(false);
      isEndedRef.current = false;
    }
  }, [currentMediaKey]);

  // Guest auto-synchronizes to room's movie/episode/language once upon initially joining the room
  const initialRoomSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!party.room) {
      initialRoomSyncedRef.current = null;
      return;
    }
    if (party.isHost) return;
    if (initialRoomSyncedRef.current === party.room.code) return;
    initialRoomSyncedRef.current = party.room.code;

    const media = party.room.media;
    if (!media || !media.slug) return;

    const isDifferentSlug = media.slug !== slug;
    const targetSeason = media.type === "tv" ? (media.season ?? 1) : undefined;
    const targetEpisode = media.type === "tv" ? (media.episode ?? 1) : undefined;
    const currentSeason = activeSeason?.number;
    const currentEpisode = activeEpisode?.number;
    const isDifferentEpisode =
      media.type === "tv" &&
      (targetSeason !== currentSeason || targetEpisode !== currentEpisode);

    if (isDifferentSlug || isDifferentEpisode) {
      latestSecondsRef.current = 0;
      setIsEnded(false);
      isEndedRef.current = false;
      console.info("Syncing guest to room media:", media.slug, targetSeason, targetEpisode);
      const code = (party.room.code || partyCode || searchPartyCode || "").trim().toUpperCase();
      if (code) {
        try {
          sessionStorage.setItem("cinemagic_watch_party", code);
        } catch {}
      }
      void navigate({
        to: "/watch/$id",
        params: { id: media.slug },
        search: {
          s: targetSeason,
          e: targetEpisode,
          party: code || undefined,
        },
      });
      return;
    }

    const isDifferentLang = Boolean(media.lang && media.lang !== selectedLang);
    if (isDifferentLang) {
      setSelectedLang(media.lang!);
      partyLangRef.current = media.lang!;
      const cur = latestSecondsRef.current ?? party.room.state.time ?? 0;
      reloadVixsrc(cur > 0 ? cur : undefined, isLocalPlaying, media.lang!);
    }
  }, [party.room, party.isHost, slug, activeSeason?.number, activeEpisode?.number, navigate, partyCode, searchPartyCode, selectedLang, isLocalPlaying, reloadVixsrc]);

  // Broadcast media changes when switching episodes or language (host or guest)
  useEffect(() => {
    if (!party.room || !title) return;
    const mediaKey = `${slug}:${season}:${episode}:${selectedLang}`;
    if (lastBroadcastMediaRef.current === mediaKey) return;

    const prevMedia = party.room.media;
    const isSameAsRoomMedia =
      prevMedia &&
      prevMedia.slug === slug &&
      (title.type !== "tv" ||
        ((prevMedia.season ?? 1) === (activeSeason?.number ?? 1) &&
         (prevMedia.episode ?? 1) === (activeEpisode?.number ?? 1))) &&
      (!prevMedia.lang || prevMedia.lang === selectedLang);

    if (isSameAsRoomMedia) {
      lastBroadcastMediaRef.current = mediaKey;
      return;
    }

    const isDifferentMedia =
      !prevMedia ||
      prevMedia.slug !== slug ||
      (title.type === "tv" &&
        ((prevMedia.season ?? 1) !== (activeSeason?.number ?? 1) ||
         (prevMedia.episode ?? 1) !== (activeEpisode?.number ?? 1)));

    lastBroadcastMediaRef.current = mediaKey;

    // When switching to a different episode or title, timestamp must reset to 0
    const timeToSend = isDifferentMedia ? 0 : (latestSecondsRef.current ?? 0);
    if (isDifferentMedia) {
      latestSecondsRef.current = 0;
      setIsEnded(false);
      isEndedRef.current = false;
      isRoomPausedRef.current = true;
      setIsPausedByRemote(true);
      isPausedByRemoteRef.current = true;
      setIsLocalPlaying(false);
      isLocalPlayingRef.current = false;
      lastReloadMetaRef.current = null;
    }

    party.sendChangeMedia(
      {
        slug,
        tmdbId: title.tmdbId,
        type: title.type,
        season: activeSeason?.number,
        episode: activeEpisode?.number,
        titleName: title.name,
        lang: selectedLang,
      },
      timeToSend,
    );
  }, [party.room, party.sendChangeMedia, slug, season, episode, selectedLang, title, activeSeason, activeEpisode]);

  const handleLanguageChange = useCallback(
    (newLang: string) => {
      setSelectedLang(newLang);
      partyLangRef.current = newLang;

      const curTime = latestSecondsRef.current ?? party.room?.state?.time ?? 0;
      if (party.room && title) {
        party.sendChangeMedia(
          {
            slug,
            tmdbId: title.tmdbId,
            type: title.type,
            season: activeSeason?.number,
            episode: activeEpisode?.number,
            titleName: title.name,
            lang: newLang,
          },
          curTime,
        );
      }

      lastReloadMetaRef.current = null;
      reloadVixsrc(curTime > 0 ? curTime : undefined, isLocalPlaying, newLang);
    },
    [party.room, party.sendChangeMedia, title, slug, activeSeason?.number, activeEpisode?.number, reloadVixsrc, isLocalPlaying],
  );

  // Automatically update video audio language when the site's locale is switched
  const prevLocaleRef = useRef(locale);
  useEffect(() => {
    if (prevLocaleRef.current !== locale) {
      prevLocaleRef.current = locale;
      if (!party.room || party.isHost) {
        handleLanguageChange(locale);
      }
    }
  }, [locale, party.room, party.isHost, handleLanguageChange]);

  const handleCreateParty = async () => {
    if (!title || isCreatingParty) return;
    setIsCreatingParty(true);
    party.setError(null);
    try {
      const rawTime = latestSecondsRef.current;
      const initialTime =
        typeof rawTime === "number" && Number.isFinite(rawTime) && rawTime >= 0
          ? rawTime
          : 0;

      const guestId = getOrCreateGuestId();
      const res = await createPartyRoom({
        data: {
          media: {
            slug,
            tmdbId: title.tmdbId ?? null,
            type: title.type === "tv" ? "tv" : "movie",
            season: activeSeason?.number ?? null,
            episode: activeEpisode?.number ?? null,
            titleName: title.name,
            lang: selectedLang,
          },
          initialTime,
          isPlaying: isLocalPlayingRef.current,
          guestId,
          guestName: viewer?.name,
          guestColor: viewer?.color,
          guestAvatar: viewer?.profilePicture,
        },
      });

      if (!res.ok || !res.room) {
        party.setError(res.message || "Impossibile creare la stanza");
        return;
      }

      // Immediately set the room so UI transitions to the active room view without delay
      party.setRoom(res.room);
      party.setCurrentAccountId(res.room.hostId);
      isRoomPausedRef.current = !res.room.state.isPlaying;
      setIsPausedByRemote(false);
      isPausedByRemoteRef.current = false;
      const cleanCode = res.room.code.trim().toUpperCase();
      setPartyCode(cleanCode);
      try {
        sessionStorage.setItem("cinemagic_watch_party", cleanCode);
      } catch {}
      void navigate({
        to: "/watch/$id",
        params: { id },
        search: {
          s: activeSeason?.number,
          e: activeEpisode?.number,
          party: cleanCode,
        },
        replace: true,
      });
    } catch (err) {
      console.error("Failed to create watch party:", err);
      party.setError(err instanceof Error ? err.message : "Errore durante la creazione della stanza");
    } finally {
      setIsCreatingParty(false);
    }
  };

  const handleJoinParty = async (code: string) => {
    const cleanCode = code.trim().toUpperCase();
    if (!cleanCode) return;
    party.setError(null);
    setPartyCode(cleanCode);
    try {
      sessionStorage.setItem("cinemagic_watch_party", cleanCode);
    } catch {}

    // Fetch room state via REST so UI loads immediately and guest syncs to host's media
    try {
      const res = await getPartyRoom({ data: { code: cleanCode } });
      if (!res.ok || !res.room) {
        party.setError(res.message || "Stanza non trovata o scaduta");
        return;
      }

      party.setRoom(res.room);
      setPartyDialogOpen(false);
      if (res.room.media?.lang && res.room.media.lang !== selectedLang) {
        setSelectedLang(res.room.media.lang);
        partyLangRef.current = res.room.media.lang;
      }
      const targetMedia = res.room.media;
      if (targetMedia && targetMedia.slug) {
        const isDiffSlug = targetMedia.slug !== slug;
        const targetSeason = targetMedia.type === "tv" ? targetMedia.season ?? 1 : undefined;
        const targetEpisode = targetMedia.type === "tv" ? targetMedia.episode ?? 1 : undefined;
        const isDiffEp =
          targetMedia.type === "tv" &&
          (targetSeason !== activeSeason?.number || targetEpisode !== activeEpisode?.number);

        if (isDiffSlug || isDiffEp) {
          latestSecondsRef.current = 0;
          void navigate({
            to: "/watch/$id",
            params: { id: targetMedia.slug },
            search: {
              s: targetSeason,
              e: targetEpisode,
              party: cleanCode,
            },
          });
          return;
        }
      }
      if (res.room.state) {
        const roomTime = Math.max(0, res.room.state.time || 0);
        latestSecondsRef.current = roomTime;
        if (res.room.state.isPlaying) {
          isRoomPausedRef.current = false;
          setIsPausedByRemote(false);
          isPausedByRemoteRef.current = false;
          setIsLocalPlaying(true);
          isLocalPlayingRef.current = true;
          reloadVixsrc(roomTime, true, res.room.media?.lang || undefined, true);
        } else {
          isRoomPausedRef.current = true;
          setIsPausedByRemote(true);
          isPausedByRemoteRef.current = true;
          setIsLocalPlaying(false);
          isLocalPlayingRef.current = false;
        }
      }
    } catch (err) {
      party.setError(err instanceof Error ? err.message : "Errore durante la connessione alla stanza");
      return;
    }

    void navigate({
      to: "/watch/$id",
      params: { id },
      search: {
        s: activeSeason?.number,
        e: activeEpisode?.number,
        party: cleanCode,
      },
      replace: true,
    });
  };

  const handleLeaveParty = useCallback(() => {
    isLeavingPartyRef.current = true;
    isRoomPausedRef.current = false;
    setIsPausedByRemote(false);
    isPausedByRemoteRef.current = false;
    setIsEnded(false);
    isEndedRef.current = false;
    try {
      sessionStorage.removeItem("cinemagic_watch_party");
    } catch {}
    void party.leaveParty();
    setPartyCode(null);
    setPartyDialogOpen(false);
    void navigate({
      to: "/watch/$id",
      params: { id },
      search: (prev) => ({
        ...prev,
        party: undefined,
      }),
      replace: true,
    });
  }, [id, navigate, party]);

  // Initialize Vixsrc iframe URL once when media or marker is ready
  const initialVixsrcLoadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!title?.tmdbId || !player || !markerLoaded) return;
    const mediaKey = `${slug}:${season}:${episode}`;
    if (initialVixsrcLoadedRef.current === mediaKey) return;
    // If waiting for party room to load from URL search param, wait until party.room is loaded
    if (searchPartyCode && !party.room && !party.error) return;

    initialVixsrcLoadedRef.current = mediaKey;
    const initialStart = party.room
      ? (isRoomMatchingMedia && party.room.state?.time && party.room.state.time > 0
          ? party.room.state.time
          : undefined)
      : (marker ?? undefined);
    const effectiveRoomPlaying = party.room ? Boolean(isRoomMatchingMedia && party.room.state.isPlaying) : false;
    const initialAutoplay = party.room ? effectiveRoomPlaying : undefined;
    if (party.room) {
      setIsLocalPlaying(effectiveRoomPlaying);
      isLocalPlayingRef.current = effectiveRoomPlaying;
      isRoomPausedRef.current = !effectiveRoomPlaying;
      setIsPausedByRemote(!effectiveRoomPlaying);
      isPausedByRemoteRef.current = !effectiveRoomPlaying;
      if (initialStart !== undefined) {
        latestSecondsRef.current = initialStart;
      }
      if (!effectiveRoomPlaying) {
        lastReloadMetaRef.current = null;
      }
    }
    reloadVixsrc(initialStart, initialAutoplay, undefined, Boolean(party.room));
  }, [
    title?.tmdbId,
    player,
    markerLoaded,
    slug,
    season,
    episode,
    searchPartyCode,
    party.room,
    party.error,
    isRoomMatchingMedia,
    marker,
    reloadVixsrc,
  ]);

  // Load the marker from the server first; fall back to a localStorage copy
  // that was saved as a cross-session safety net when the service was down.
  useEffect(() => {
    if (!title) return;

    let cancelled = false;
    setMarker(null);
    setMarkerLoaded(false);

    (async () => {
      const watched = await getWatchMarker({
        data: { slug, season, episode },
      });
      if (cancelled) return;
      let saved = watched?.marker;
      if (saved === undefined || saved === null) {
        try {
          const local = localStorage.getItem(`watch-marker:${slug}:${season}:${episode}`);
          if (local !== null) {
            const parsed = parseInt(local, 10);
            if (!Number.isNaN(parsed) && parsed > 0) saved = parsed;
          }
        } catch {
          // localStorage unavailable — ignore.
        }
      }
      setMarker(saved !== undefined && saved !== null ? saved : null);
      setMarkerLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [title, slug, season, episode]);

  // Record a play row the moment playback has a resolvable source, so the
  // title shows up in "recently watched" and resume can find a marker row
  // even if the user stops before the debounced marker write fires.
  useEffect(() => {
    if (!title || (!playlistUrl && !embedUrl)) return;

    let cancelled = false;
    playLoggedRef.current = false;

    (async () => {
      await recordPlay({
        data: { slug, title, season, episode },
      });
      if (cancelled) return;
      playLoggedRef.current = true;
    })();

    return () => {
      cancelled = true;
    };
  }, [title, playlistUrl, embedUrl, slug, season, episode]);

  // Debounced persistence of the current playback position.
  useEffect(() => {
    return () => {
      const seconds = latestSecondsRef.current;
      if (seconds !== null && Number.isFinite(seconds)) {
        if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
        saveDebounceRef.current = null;
        const clamped = Math.max(0, Math.round(seconds));
        void updateWatchMarker({
          data: { slug, title, season, episode, marker: clamped },
        });
        try {
          const key = `watch-marker:${slug}:${season}:${episode}`;
          localStorage.setItem(key, String(clamped));
        } catch {
          // Ignore quota/storage errors — the server write is the source of truth.
        }
      }
      latestSecondsRef.current = 0;
    };
  }, [slug, title, season, episode]);

  function saveCompletedMarkerToStorage() {
    clearCompletedMarker();
    if (!title) return;
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = null;
    void updateWatchMarker({
      data: { slug, title, season, episode, marker: 0 },
    });
    try {
      const key = `watch-marker:${slug}:${season}:${episode}`;
      localStorage.setItem(key, "0");
    } catch {
      // Ignore quota/storage errors — the server write is the source of truth.
    }
  }

  function persistMarker(seconds: number, immediate = false) {
    if (!markerLoaded) return;
    latestSecondsRef.current = seconds;
    const isCompleted = playbackDurationSeconds > 0 && seconds >= playbackDurationSeconds;
    const markerValue = isCompleted ? 0 : seconds;
    if (isCompleted) {
      clearCompletedMarker();
    }
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    const save = () => {
      saveDebounceRef.current = null;
      if (!title) return;
      const clamped = Math.max(0, Math.round(markerValue));
      void updateWatchMarker({
        data: { slug, title, season, episode, marker: clamped },
      });
      queryClient.setQueryData<WatchEntry[] | null>(
        historyQuery.queryKey,
        (current) =>
          current?.map((entry) =>
            entry.slug === slug && entry.season === season && entry.episode === episode
              ? { ...entry, marker: clamped }
              : entry,
          ) ?? null,
      );
      try {
        const key = `watch-marker:${slug}:${season}:${episode}`;
        localStorage.setItem(key, String(clamped));
      } catch {
        // Ignore quota/storage errors — the server write is the source of truth.
      }
    };
    if (immediate) {
      save();
    } else {
      saveDebounceRef.current = setTimeout(save, 2000);
    }
  }

  function flushMarker() {
    const seconds = latestSecondsRef.current;
    if (seconds === null || !title) return;
    persistMarker(seconds, true);
  }

  useEffect(() => {
    if (!markerLoaded) return;

    window.addEventListener("pagehide", flushMarker);
    return () => {
      window.removeEventListener("pagehide", flushMarker);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerLoaded, slug, title, season, episode]);

  const persistMarkerRef = useRef(persistMarker);
  persistMarkerRef.current = persistMarker;
  const saveCompletedMarkerRef = useRef(saveCompletedMarkerToStorage);
  saveCompletedMarkerRef.current = saveCompletedMarkerToStorage;

  // Clean up all pending playback sync timers only on component unmount
  useEffect(() => {
    return () => {
      if (pauseDebounceRef.current) clearTimeout(pauseDebounceRef.current);
      if (localSeekDebounceRef.current) clearTimeout(localSeekDebounceRef.current);
      if (localPlayDebounceRef.current) clearTimeout(localPlayDebounceRef.current);
      if (remoteSeekDebounceRef.current) clearTimeout(remoteSeekDebounceRef.current);
    };
  }, []);

  // Listen for player events (play, pause, seek, ended, timeupdate) from embed players (e.g. Vixsrc)
  useEffect(() => {
    if (!markerLoaded) return;

    const toValidSeconds = (v: unknown): number | null => {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
      if (typeof v === "string") {
        const p = parseFloat(v);
        if (Number.isFinite(p) && p >= 0) return p;
      }
      return null;
    };

    const parsePlayerMessage = (
      rawData: unknown,
    ): {
      eventName: string;
      seconds: number | null;
      totalDuration: number | null;
      pauseReason: string;
      oldState: string;
    } | null => {
      let data = rawData;
      if (typeof data === "string") {
        const trimmed = data.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try {
            data = JSON.parse(trimmed);
          } catch {
            return null;
          }
        } else {
          const lower = trimmed.toLowerCase();
          if (lower.startsWith("time:")) {
            const parsed = parseFloat(lower.slice(5));
            return Number.isFinite(parsed) && parsed >= 0
              ? { eventName: "timeupdate", seconds: parsed, totalDuration: null, pauseReason: "", oldState: "" }
              : null;
          }
          if (
            lower === "pause" ||
            lower === "play" ||
            lower === "playing" ||
            lower === "start" ||
            lower === "seeking" ||
            lower === "seek" ||
            lower === "seeked" ||
            lower === "ended" ||
            lower === "finish" ||
            lower === "complete"
          ) {
            return { eventName: lower, seconds: null, totalDuration: null, pauseReason: "", oldState: "" };
          }
          return null;
        }
      }

      if (!data || typeof data !== "object") return null;
      const record = data as PlayerMessagePayload;

      let eventName = "";
      let seconds: number | null = null;
      let totalDuration: number | null = null;

      if (typeof record.event === "object" && record.event !== null) {
        const evObj = record.event;
        if (typeof evObj.event === "string") eventName = evObj.event.toLowerCase();
        seconds = toValidSeconds(evObj.position) ?? toValidSeconds(evObj.currentTime) ?? toValidSeconds(evObj.offset);
        totalDuration = toValidSeconds(evObj.duration);
      } else if (typeof record.event === "string") {
        eventName = record.event.toLowerCase();
      }

      if (typeof record.data === "object" && record.data !== null) {
        const dataObj = record.data;
        if (!eventName && typeof dataObj.event === "string") {
          eventName = dataObj.event.toLowerCase();
        }
        if (seconds === null) {
          seconds = toValidSeconds(dataObj.position) ?? toValidSeconds(dataObj.currentTime) ?? toValidSeconds(dataObj.offset);
        }
        if (totalDuration === null) {
          totalDuration = toValidSeconds(dataObj.duration);
        }
      }

      if (!eventName && typeof record.type === "string" && record.type !== "PLAYER_EVENT") {
        eventName = record.type.toLowerCase();
      }

      const evAny = record.event as Record<string, unknown> | undefined;
      const dataAny = record.data as Record<string, unknown> | undefined;
      const nestedMeta =
        evAny && typeof evAny["data"] === "object" && evAny["data"] !== null
          ? (evAny["data"] as Record<string, unknown>)
          : dataAny && typeof dataAny["data"] === "object" && dataAny["data"] !== null
            ? (dataAny["data"] as Record<string, unknown>)
            : dataAny ?? evAny ?? null;

      const pauseReason =
        nestedMeta && typeof nestedMeta["pauseReason"] === "string"
          ? nestedMeta["pauseReason"].toLowerCase()
          : "";
      const oldState =
        nestedMeta && typeof nestedMeta["oldstate"] === "string"
          ? nestedMeta["oldstate"].toLowerCase()
          : "";

      if (seconds === null) {
        const candidates = [
          evAny && typeof evAny["data"] === "object" ? (evAny["data"] as Record<string, unknown>) : null,
          dataAny && typeof dataAny["data"] === "object" ? (dataAny["data"] as Record<string, unknown>) : null,
          evAny,
          dataAny,
          record,
          record.info,
          record.payload,
        ];
        for (const cand of candidates) {
          if (cand && typeof cand === "object") {
            const c = cand as PlayerEventData;
            const valid =
              toValidSeconds(c.position) ??
              toValidSeconds(c.offset) ??
              toValidSeconds(c.currentTime) ??
              toValidSeconds(c.time) ??
              toValidSeconds(c.seconds) ??
              toValidSeconds(c.value);
            if (valid !== null) {
              seconds = valid;
              break;
            }
          }
        }
      }

      if (totalDuration === null) {
        const candidates = [record, record.data, record.event, record.info, record.payload];
        for (const cand of candidates) {
          if (cand && typeof cand === "object") {
            const c = cand as PlayerEventData;
            const valid = toValidSeconds(c.duration);
            if (valid !== null && valid > 0) {
              totalDuration = valid;
              break;
            }
          }
        }
      }

      if (!eventName && seconds === null) return null;
      return { eventName, seconds, totalDuration, pauseReason, oldState };
    };

    const handlePlayerMessage = (event: MessageEvent) => {
      // Ignore self-dispatched messages; allow nested player iframes inside the embed provider
      if (event.source === window) return;

      const raw = event.data;
      if (!raw) return;

      // Ignore React DevTools / webpack / unrelated messages
      if (
        typeof raw === "object" &&
        "source" in raw &&
        typeof (raw as Record<string, unknown>)["source"] === "string" &&
        String((raw as Record<string, unknown>)["source"]).startsWith("react-devtools")
      ) {
        return;
      }

      const parsed = parsePlayerMessage(raw);
      if (!parsed) return;
      const { eventName, seconds, totalDuration, pauseReason, oldState } = parsed;

      if (totalDuration !== null && totalDuration > 0) {
        lastKnownDurationRef.current = totalDuration;
      }

      const scheduleLocalSeekBroadcast = (sec: number) => {
        if (!Number.isFinite(sec) || sec < 0) return;
        latestSecondsRef.current = sec;
        persistMarkerRef.current(sec, true);
        lastSeekActivityAtRef.current = Date.now();
        if (pauseDebounceRef.current) {
          clearTimeout(pauseDebounceRef.current);
          pauseDebounceRef.current = null;
        }
        const activeParty = partyRef.current;
        const suppressBroadcast =
          !activeParty.room ||
          activeParty.isRemoteSyncingRef.current ||
          Date.now() - lastRemoteReloadRef.current < REMOTE_SUPPRESS_MS ||
          (remoteActionRef.current.type === "seek" &&
            Date.now() - remoteActionRef.current.ts < REMOTE_SUPPRESS_MS);
        if (suppressBroadcast) return;

        if (localSeekDebounceRef.current) {
          clearTimeout(localSeekDebounceRef.current);
        }
        localSeekDebounceRef.current = setTimeout(() => {
          localSeekDebounceRef.current = null;
          const p = partyRef.current;
          if (
            !p.room ||
            p.isRemoteSyncingRef.current ||
            Date.now() - lastRemoteReloadRef.current < REMOTE_SUPPRESS_MS
          ) {
            return;
          }
          const finalSec = latestSecondsRef.current ?? sec;
          lastSeekActivityAtRef.current = Date.now();
          p.sendSeek(finalSec);
        }, 400);
      };

      const scheduleLocalPlayBroadcast = () => {
        if (pauseDebounceRef.current) {
          clearTimeout(pauseDebounceRef.current);
          pauseDebounceRef.current = null;
        }
        if (!partyRef.current.room) return;
        if (localPlayDebounceRef.current) {
          clearTimeout(localPlayDebounceRef.current);
        }
        const waitMs =
          pendingSeekEventAtRef.current > 0 && Date.now() - pendingSeekEventAtRef.current < 1500
            ? 450
            : 200;
        localPlayDebounceRef.current = setTimeout(() => {
          localPlayDebounceRef.current = null;
          const p = partyRef.current;
          if (
            !p.room ||
            p.isRemoteSyncingRef.current ||
            Date.now() - lastRemoteReloadRef.current < REMOTE_SUPPRESS_MS
          ) {
            return;
          }
          // Cancel any overlapping seek debounce; PLAY carries the latest timestamp
          if (localSeekDebounceRef.current) {
            clearTimeout(localSeekDebounceRef.current);
            localSeekDebounceRef.current = null;
          }
          const targetSec = latestSecondsRef.current ?? 0;
          p.sendPlay(targetSec);
        }, waitMs);
      };

      const scheduleDebouncedPause = (curSec: number) => {
        if (localPlayDebounceRef.current) {
          clearTimeout(localPlayDebounceRef.current);
          localPlayDebounceRef.current = null;
        }
        if (pauseDebounceRef.current) {
          clearTimeout(pauseDebounceRef.current);
        }
        pauseDebounceRef.current = setTimeout(() => {
          pauseDebounceRef.current = null;
          if (isEndedRef.current) return;
          // Flush or supersede any pending local seek since sendPause carries targetSec cleanly
          if (localSeekDebounceRef.current) {
            clearTimeout(localSeekDebounceRef.current);
            localSeekDebounceRef.current = null;
          }
          const targetSec = latestSecondsRef.current ?? curSec;
          const knownDur = lastKnownDurationRef.current;
          if (knownDur > 0 && targetSec >= knownDur - 3) {
            setIsEnded(true);
            isEndedRef.current = true;
            setIsLocalPlaying(false);
            isLocalPlayingRef.current = false;
            saveCompletedMarkerRef.current();
            return;
          }
          const p = partyRef.current;
          isRoomPausedRef.current = true;
          if (p.room && (hlsFailed || !playlistUrl)) {
            setIsPausedByRemote(true);
            isPausedByRemoteRef.current = true;
            lastReloadMetaRef.current = null;
          }
          setIsLocalPlaying(false);
          isLocalPlayingRef.current = false;
          if (Number.isFinite(targetSec) && targetSec >= 0) {
            persistMarkerRef.current(targetSec, true);
          }
          const suppressBroadcast =
            p.isRemoteSyncingRef.current ||
            (lastRemoteReloadRef.current > 0 &&
              Date.now() - lastRemoteReloadRef.current < REMOTE_SUPPRESS_MS) ||
            (remoteActionRef.current.type === "pause" &&
              Date.now() - remoteActionRef.current.ts < REMOTE_SUPPRESS_MS);
          if (!suppressBroadcast && p.room && Number.isFinite(targetSec)) {
            p.sendPause(targetSec);
          }
        }, 350);
      };

      // 1. Video completion
      if (eventName === "ended" || eventName === "complete" || eventName === "finish") {
        if (pauseDebounceRef.current) {
          clearTimeout(pauseDebounceRef.current);
          pauseDebounceRef.current = null;
        }
        if (localSeekDebounceRef.current) {
          clearTimeout(localSeekDebounceRef.current);
          localSeekDebounceRef.current = null;
        }
        if (localPlayDebounceRef.current) {
          clearTimeout(localPlayDebounceRef.current);
          localPlayDebounceRef.current = null;
        }
        pendingSeekEventAtRef.current = 0;
        setIsEnded(true);
        isEndedRef.current = true;
        setIsLocalPlaying(false);
        isLocalPlayingRef.current = false;
        saveCompletedMarkerRef.current();
        return;
      }

      // Update saved marker to 0 if near the actual end, without resetting latestSecondsRef
      const knownDur = lastKnownDurationRef.current;
      if (seconds !== null && knownDur > 0 && seconds >= knownDur - 8) {
        saveCompletedMarkerRef.current();
      }

      // 2. Seek events (Vixsrc sends "seeked" with currentTime=NaN -> seconds=null!)
      if (eventName === "seeked" || eventName === "seek" || eventName === "seeking") {
        if (pauseDebounceRef.current) {
          clearTimeout(pauseDebounceRef.current);
          pauseDebounceRef.current = null;
        }
        setIsEnded(false);
        isEndedRef.current = false;
        lastSeekActivityAtRef.current = Date.now();

        const startup = iframeStartupRef.current;
        const inStartupSettle =
          !startup.hasStartedPlaying ||
          (startup.playingSince > 0 && Date.now() - startup.playingSince < 2000);
        if (inStartupSettle && (seconds === null || Math.abs(seconds - startup.targetTime) <= 5)) {
          return;
        }

        if (seconds !== null && Number.isFinite(seconds) && seconds >= 0) {
          pendingSeekEventAtRef.current = 0;
          scheduleLocalSeekBroadcast(seconds);
        } else {
          // Do NOT broadcast latestSecondsRef (that is the old pre-seek timestamp);
          // wait for the upcoming timeupdate carrying the true post-seek currentTime.
          pendingSeekEventAtRef.current = Date.now();
        }
        return;
      }

      // 3. Pause events
      if (eventName === "pause") {
        const curSec = seconds ?? latestSecondsRef.current ?? 0;
        const isNearEnd =
          isEndedRef.current ||
          (knownDur > 0 && curSec >= knownDur - 3);

        if (isNearEnd) {
          setIsEnded(true);
          isEndedRef.current = true;
          setIsLocalPlaying(false);
          isLocalPlayingRef.current = false;
          saveCompletedMarkerRef.current();
          return;
        }

        if (!iframeStartupRef.current.hasStartedPlaying) {
          // Ignore startup/blocked-autoplay pause (oldstate="idle"), but honor real pauses if player was already playing
          if (oldState === "playing" || pauseReason === "interaction") {
            iframeStartupRef.current.hasStartedPlaying = true;
            iframeStartupRef.current.playingSince = Date.now();
            iframeStartupRef.current.expectedAutoplay = false;
          } else {
            return;
          }
        }

        if (
          Number.isFinite(curSec) &&
          curSec >= 0 &&
          Date.now() - lastRemoteReloadRef.current >= REMOTE_SUPPRESS_MS
        ) {
          latestSecondsRef.current = curSec;
        }

        scheduleDebouncedPause(curSec);
        return;
      }

      // 4. Play events
      if (eventName === "play" || eventName === "playing" || eventName === "start") {
        if (pauseDebounceRef.current) {
          clearTimeout(pauseDebounceRef.current);
          pauseDebounceRef.current = null;
        }
        const wasRoomPaused = isRoomPausedRef.current;
        setIsEnded(false);
        isEndedRef.current = false;
        isRoomPausedRef.current = false;
        setIsPausedByRemote(false);
        isPausedByRemoteRef.current = false;
        setIsLocalPlaying(true);
        isLocalPlayingRef.current = true;

        const startup = iframeStartupRef.current;
        if (!startup.hasStartedPlaying) {
          startup.hasStartedPlaying = true;
          startup.playingSince = Date.now();
          const wasExpectedAutoplay = startup.expectedAutoplay;
          startup.expectedAutoplay = false;
          if (wasExpectedAutoplay && !wasRoomPaused) {
            // Startup autoplay (or delayed mobile tap after blocked autoplay) in an already-playing room
            return;
          }
        }

        const p = partyRef.current;
        const isSuppressed =
          p.isRemoteSyncingRef.current ||
          Date.now() - lastRemoteReloadRef.current < REMOTE_SUPPRESS_MS ||
          (remoteActionRef.current.type === "play" &&
            Date.now() - remoteActionRef.current.ts < REMOTE_SUPPRESS_MS);
        if (isSuppressed) {
          return;
        }

        if (seconds !== null && Date.now() - lastRemoteReloadRef.current >= REMOTE_SUPPRESS_MS) {
          latestSecondsRef.current = seconds;
        }

        // Only broadcast PLAY if the room was actually paused (avoid echo during scrub/buffering)
        if (wasRoomPaused && p.room) {
          scheduleLocalPlayBroadcast();
        }
        return;
      }

      // 5. Timeupdate events (Vixsrc's primary source of valid currentTime!)
      if (eventName === "timeupdate" || eventName === "time" || seconds !== null) {
        if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return;

        const startup = iframeStartupRef.current;
        // Ignore pre-seek 0s emitted while a newly mounted iframe is still seeking to targetTime
        if (
          !startup.hasStartedPlaying &&
          startup.targetTime > 3 &&
          seconds < 3 &&
          Date.now() - startup.mountedAt < 8000
        ) {
          return;
        }

        if (!startup.hasStartedPlaying) {
          if (Date.now() - startup.mountedAt < 1800 && startup.targetTime > 3 && Math.abs(seconds - startup.targetTime) > 10) {
            return;
          }
          if (
            Date.now() - lastRemoteReloadRef.current >= REMOTE_SUPPRESS_MS &&
            (!startup.expectedAutoplay || (seconds > 0 && Math.abs(seconds - startup.targetTime) <= 10))
          ) {
            startup.hasStartedPlaying = true;
            startup.playingSince = Date.now();
            startup.expectedAutoplay = false;
          }
        }

        // Ignore trailing timeupdate messages from an unloading iframe during remote reload (first 500ms)
        if (lastRemoteReloadRef.current > 0 && Date.now() - lastRemoteReloadRef.current < 500) {
          return;
        }

        const prevSec = latestSecondsRef.current;
        latestSecondsRef.current = seconds;
        persistMarkerRef.current(seconds, false);

        const p = partyRef.current;
        const hasPendingSeekEvent =
          pendingSeekEventAtRef.current > 0 &&
          Date.now() - pendingSeekEventAtRef.current < 2500;
        const jumpedBackward = prevSec !== null && prevSec > 0 && seconds < prevSec - 2.0;
        const jumpedForward = prevSec !== null && seconds > prevSec + 3.5;
        const isNearStartupTarget =
          startup.playingSince > 0 &&
          Date.now() - startup.playingSince < 2000 &&
          Math.abs(seconds - startup.targetTime) <= 6;

        if (
          p.room &&
          startup.hasStartedPlaying &&
          !isNearStartupTarget &&
          !p.isRemoteSyncingRef.current &&
          !(remoteActionRef.current.type === "seek" && Date.now() - remoteActionRef.current.ts < REMOTE_SUPPRESS_MS) &&
          (hasPendingSeekEvent || jumpedBackward || jumpedForward)
        ) {
          pendingSeekEventAtRef.current = 0;
          if (pauseDebounceRef.current) {
            clearTimeout(pauseDebounceRef.current);
            pauseDebounceRef.current = null;
          }
          if (localPlayDebounceRef.current) {
            // Pending PLAY broadcast will carry this updated seconds value
            return;
          }
          scheduleLocalSeekBroadcast(seconds);
        }
      }
    };

    window.addEventListener("message", handlePlayerMessage);
    return () => {
      window.removeEventListener("message", handlePlayerMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerLoaded]);

  if (!title) return null;

  const showFallbackNotice = hlsFailed || (streamQuery.isFetched && !playlistUrl);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <Link
            to="/title/$id"
            params={{ id }}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            {t("watch_backToDetails")}
          </Link>
          <h1 className="truncate font-display text-2xl font-semibold text-foreground">
            {title.name}
          </h1>
          {activeSeason && activeEpisode ? (
            <p className="text-sm text-muted-foreground">
              S{activeSeason.number} - E{activeEpisode.number} - {activeEpisode.name}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs font-medium"
                title="Seleziona lingua audio"
              >
                <Languages className="size-3.5" />
                <span>Audio: {selectedLang === "it" ? "Italiano" : selectedLang === "en" ? "English" : selectedLang.toUpperCase()}</span>
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleLanguageChange("it")}>
                🇮🇹 Italiano {selectedLang === "it" && "✓"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleLanguageChange("en")}>
                🇬🇧 English {selectedLang === "en" && "✓"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setPartyDialogOpen(true)}
            className={`gap-2 text-xs transition-colors ${
              party.room
                ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
                : ""
            }`}
          >
            <Users className="size-3.5" />
            {party.room ? (
              <span className="flex items-center gap-1.5">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
                </span>
                <span>
                  {t("party_inParty")} ({party.members.length})
                </span>
              </span>
            ) : (
              <span>{t("party_title")}</span>
            )}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={toggleFullscreen}
            className="gap-1.5 text-xs font-medium"
            title={isFullscreen ? "Esci dallo schermo intero (F)" : "Schermo intero (F)"}
          >
            {isFullscreen ? <Minimize className="size-3.5" /> : <Maximize className="size-3.5" />}
            <span className="hidden sm:inline">{isFullscreen ? "Riduci" : "Schermo intero"}</span>
          </Button>
        </div>
      </div>

      <WatchTogetherDialog
        open={partyDialogOpen}
        onOpenChange={setPartyDialogOpen}
        room={party.room}
        members={party.members}
        currentAccountId={party.currentAccountId}
        isHost={party.isHost}
        isConnected={party.isConnected}
        isConnecting={party.isConnecting}
        isCreating={isCreatingParty}
        error={party.error}
        chatMessages={party.chatMessages}
        onCreateParty={handleCreateParty}
        onJoinParty={handleJoinParty}
        onLeaveParty={handleLeaveParty}
        onSendChat={party.sendChat}
      />

      {playlistUrl && !hlsFailed ? (
        <div className="aspect-video w-full overflow-hidden rounded-xl border border-border bg-black">
          <HlsPlayer
            ref={hlsPlayerRef}
            src={playlistUrl}
            title={`${title.name} player`}
            onFatal={() => setHlsFailed(true)}
            onTimeUpdate={(seconds) => persistMarker(seconds)}
            onPlay={(sec) => {
              setIsLocalPlaying(true);
              if (!party.isRemoteSyncingRef.current && party.room) {
                party.sendPlay(sec);
              }
            }}
            onPause={(sec) => {
              setIsLocalPlaying(false);
              if (!party.isRemoteSyncingRef.current && party.room) {
                party.sendPause(sec);
              }
            }}
            onSeek={(sec) => {
              if (!party.isRemoteSyncingRef.current && party.room) {
                party.sendSeek(sec);
              }
            }}
            initialSeconds={
              party.room
                ? (isRoomMatchingMedia && party.room.state?.time && party.room.state.time > 0
                    ? party.room.state.time
                    : undefined)
                : (marker ?? undefined)
            }
          />
        </div>
      ) : streamQuery.isLoading || !markerLoaded ? (
        <div className="flex aspect-video w-full items-center justify-center rounded-xl border border-border bg-black">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : embedUrl ? (
        <div className="space-y-2">
          {showFallbackNotice ? (
            <p className="text-xs text-muted-foreground">{t("watch_unavailable")}</p>
          ) : null}
          {adBlockPrompt.shouldShow ? <AdBlockPrompt browser={adBlockPrompt.info.browser} /> : null}
          <div
            ref={playerContainerRef}
            onMouseMove={handleUserActivity}
            onPointerMove={handleUserActivity}
            onMouseDown={handleUserActivity}
            onTouchStart={handleUserActivity}
            className={`group relative w-full overflow-hidden bg-black transition-all ${
              isCssFullscreen
                ? `fixed inset-0 z-50 h-[100dvh] w-screen rounded-none border-none ${!isUserActive ? "cursor-none" : ""}`
                : isFullscreen
                  ? `h-screen rounded-none border-none ${!isUserActive ? "cursor-none" : ""}`
                  : "aspect-video rounded-xl border border-border"
            }`}
          >
            {(!party.room || (!isPausedByRemote && !isEnded)) && (
              <iframe
                key={vixsrcIframeKey}
                ref={iframeRef}
                src={vixsrcEmbedUrl ?? embedUrl}
                title={`${title.name} player`}
                className="size-full"
                allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                referrerPolicy="origin"
              />
            )}

            {/* In fullscreen, transparent overlay that hides cursor when idle and wakes up on mouse movement */}
            {isFullscreen && (
              <div
                onMouseMove={handleUserActivity}
                onPointerMove={handleUserActivity}
                onMouseDown={handleUserActivity}
                onTouchStart={handleUserActivity}
                className={`absolute inset-0 z-10 bg-transparent transition-opacity duration-300 ${
                  !isUserActive
                    ? "pointer-events-auto cursor-none"
                    : "pointer-events-none cursor-default"
                }`}
                aria-hidden="true"
              />
            )}

            {/* Quick fullscreen toggle button on player container */}
            <button
              type="button"
              onClick={toggleFullscreen}
              className={`absolute top-3 right-3 z-30 rounded-lg bg-black/60 p-2 text-white/80 backdrop-blur transition-opacity duration-300 hover:bg-black/90 hover:text-white ${
                isFullscreen
                  ? isUserActive
                    ? "opacity-100 pointer-events-auto"
                    : "opacity-0 pointer-events-none"
                  : "opacity-0 group-hover:opacity-100 focus:opacity-100 pointer-events-auto"
              }`}
              title={isFullscreen ? "Esci dallo schermo intero (F)" : "Schermo intero (F)"}
            >
              {isFullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
            </button>

            {party.room && (isPausedByRemote || isEnded) && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/85 backdrop-blur-sm transition-all">
                {title.backdropUrl ? (
                  <img
                    src={title.backdropUrl}
                    alt=""
                    className="absolute inset-0 size-full object-cover opacity-20 filter blur-sm pointer-events-none select-none"
                  />
                ) : null}
                <div className="relative z-10 flex flex-col items-center gap-3 rounded-xl border border-border/80 bg-card/95 p-6 text-center shadow-2xl max-w-sm mx-4">
                  {isEnded ? (
                    <>
                      <div className="rounded-full bg-emerald-500/10 p-3 text-emerald-400">
                        <CheckCircle2 className="size-6" />
                      </div>
                      <div className="space-y-1">
                        <h3 className="text-base font-semibold text-foreground">
                          {activeEpisode ? "Episodio terminato" : "Visione completata"}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          {nextEpisode
                            ? `Passa al prossimo episodio (E${nextEpisode.episodeNumber}) per continuare a guardare insieme.`
                            : "Visione completata. Puoi ricominciare dall'inizio o scegliere un altro episodio."}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
                        {nextEpisode && (
                          <Button
                            size="sm"
                            className="gap-2 font-medium"
                            onClick={() => {
                              setIsEnded(false);
                              isEndedRef.current = false;
                              setIsPausedByRemote(false);
                              const code = (party.room?.code || partyCode || searchPartyCode || "").trim().toUpperCase();
                              void navigate({
                                to: "/watch/$id",
                                params: { id: slug },
                                search: {
                                  s: nextEpisode.seasonNumber,
                                  e: nextEpisode.episodeNumber,
                                  party: code || undefined,
                                },
                              });
                            }}
                          >
                            <Play className="size-4 fill-current" />
                            Prossimo episodio (E{nextEpisode.episodeNumber})
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          onClick={() => {
                            setIsEnded(false);
                            isEndedRef.current = false;
                            isRoomPausedRef.current = false;
                            setIsPausedByRemote(false);
                            isPausedByRemoteRef.current = false;
                            setIsLocalPlaying(true);
                            isLocalPlayingRef.current = true;
                            latestSecondsRef.current = 0;
                            lastReloadMetaRef.current = null;
                            party.isRemoteSyncingRef.current = false;
                            party.sendPlay(0);
                            reloadVixsrc(0, true);
                          }}
                        >
                          <RotateCcw className="size-3.5" />
                          Ricomincia dall'inizio
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="rounded-full bg-primary/10 p-3 text-primary">
                        <Pause className="size-6 animate-pulse" />
                      </div>
                      <div className="space-y-1">
                        <h3 className="text-base font-semibold text-foreground">Riproduzione in pausa</h3>
                        <p className="text-xs text-muted-foreground">
                          La stanza è in pausa. Clicca play per riprendere la visione insieme.
                        </p>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <Button
                          size="sm"
                          className="gap-2 font-medium"
                          onClick={() => {
                            const cur = latestSecondsRef.current ?? party.room?.state?.time ?? 0;
                            isRoomPausedRef.current = false;
                            setIsPausedByRemote(false);
                            isPausedByRemoteRef.current = false;
                            setIsLocalPlaying(true);
                            isLocalPlayingRef.current = true;
                            lastReloadMetaRef.current = null;
                            party.isRemoteSyncingRef.current = false;
                            party.sendPlay(cur);
                            if (!playlistUrl || hlsFailed) {
                              reloadVixsrc(cur, true);
                            }
                          }}
                        >
                          <Play className="size-4 fill-current" />
                          Riprendi insieme
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          onClick={toggleFullscreen}
                          title={isFullscreen ? "Esci dallo schermo intero" : "Schermo intero"}
                        >
                          {isFullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <p className="text-sm font-medium text-card-foreground">{t("title_unavailable")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {title.tmdbId ? t("watch_noHostConfigured") : t("watch_noExternalId")}
          </p>
        </div>
      )}

      {activeSeason && activeSeason.episodes.length > 0 ? (
        <section className="space-y-4">
          <ScrollableRow>
            {title.seasons.map((sn) => (
              <Link
                key={sn.number}
                to="/watch/$id"
                params={{ id }}
                search={{ s: sn.number, e: undefined, party: partyCode ?? undefined }}
                className={`shrink-0 rounded-full border px-4 py-1.5 text-xs font-medium transition-colors ${
                  sn.number === activeSeason.number
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:border-primary/50"
                }`}
              >
                {sn.name}
              </Link>
            ))}
          </ScrollableRow>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {activeSeason.episodes.map((ep) => (
              <Link
                key={ep.id}
                to="/watch/$id"
                params={{ id }}
                search={{ s: activeSeason.number, e: ep.number, party: partyCode ?? undefined }}
                className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                  ep.number === activeEpisode?.number
                    ? "border-primary bg-primary/10"
                    : "border-border bg-card hover:border-primary/50"
                }`}
              >
                <span className="w-6 shrink-0 font-display text-sm text-muted-foreground">
                  {ep.number}
                </span>
                <span className="truncate text-sm text-card-foreground">{ep.name}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
