import { useCallback, useEffect, useRef, useState } from "react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { queryOptions, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Users } from "lucide-react";
import { z } from "zod";

import { HlsPlayer, type HlsPlayerHandle } from "@/components/HlsPlayer";
import { AdBlockPrompt, useAdBlockPrompt } from "@/components/AdBlockPrompt";
import { WatchTogetherDialog } from "@/components/WatchTogetherDialog";
import { Button } from "@/components/ui/button";
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

function sendIframePlayerCommand(
  iframe: HTMLIFrameElement | null,
  command: "play" | "pause" | "seek",
  time?: number,
) {
  if (!iframe || !iframe.contentWindow) return;
  const cw = iframe.contentWindow;

  if (command === "seek" && typeof time === "number") {
    const rounded = Math.floor(time * 10) / 10;
    cw.postMessage({ type: "seek", time: rounded }, "*");
    cw.postMessage({ method: "seek", value: rounded }, "*");
    cw.postMessage({ event: "seek", time: rounded }, "*");
    cw.postMessage({ action: "seek", value: rounded, time: rounded }, "*");
    cw.postMessage({ action: "start", value: rounded, time: rounded }, "*");
    cw.postMessage({ api: "seek", time: rounded }, "*");
    cw.postMessage(`seek:${rounded}`, "*");
    cw.postMessage(`start:${rounded}`, "*");
    try {
      cw.postMessage(JSON.stringify({ type: "seek", time: rounded }), "*");
      cw.postMessage(JSON.stringify({ method: "seek", value: rounded }), "*");
      cw.postMessage(JSON.stringify({ event: "seek", time: rounded }), "*");
      cw.postMessage(JSON.stringify({ action: "seek", value: rounded }), "*");
      cw.postMessage(JSON.stringify({ action: "start", value: rounded }), "*");
      cw.postMessage(JSON.stringify({ event: "command", func: "seekTo", args: [rounded, true] }), "*");
    } catch {}
  } else if (command === "play") {
    cw.postMessage({ type: "play" }, "*");
    cw.postMessage({ method: "play" }, "*");
    cw.postMessage({ event: "play" }, "*");
    cw.postMessage({ action: "play" }, "*");
    cw.postMessage({ api: "play" }, "*");
    cw.postMessage("play", "*");
    try {
      cw.postMessage(JSON.stringify({ type: "play" }), "*");
      cw.postMessage(JSON.stringify({ method: "play" }), "*");
      cw.postMessage(JSON.stringify({ event: "play" }), "*");
      cw.postMessage(JSON.stringify({ action: "play" }), "*");
      cw.postMessage(JSON.stringify({ event: "command", func: "playVideo", args: "" }), "*");
    } catch {}
  } else if (command === "pause") {
    cw.postMessage({ type: "pause" }, "*");
    cw.postMessage({ method: "pause" }, "*");
    cw.postMessage({ event: "pause" }, "*");
    cw.postMessage({ action: "pause" }, "*");
    cw.postMessage({ api: "pause" }, "*");
    cw.postMessage("pause", "*");
    try {
      cw.postMessage(JSON.stringify({ type: "pause" }), "*");
      cw.postMessage(JSON.stringify({ method: "pause" }), "*");
      cw.postMessage(JSON.stringify({ event: "pause" }), "*");
      cw.postMessage(JSON.stringify({ action: "pause" }), "*");
      cw.postMessage(JSON.stringify({ event: "command", func: "pauseVideo", args: "" }), "*");
    } catch {}
  }
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
  const { t } = useTranslation();

  const isSeries = title?.type === "tv";
  const activeSeason = isSeries
    ? (title?.seasons.find((x) => x.number === s) ?? title?.seasons[0])
    : undefined;
  const activeEpisode = isSeries
    ? (activeSeason?.episodes.find((x) => x.number === e) ?? activeSeason?.episodes[0])
    : undefined;

  const [hlsFailed, setHlsFailed] = useState(false);
  useEffect(() => setHlsFailed(false), [id, s, e]);

  const { browser: detectedBrowser, adblockActive } = useBrowserInfo();
  const adBlockPrompt = useAdBlockPrompt({ browser: detectedBrowser, adblockActive });

  const streamQuery = useQuery({
    queryKey: ["stream", title?.tmdbId, title?.type, activeSeason?.number, activeEpisode?.number],
    queryFn: () => {
      if (!title?.tmdbId) return null;
      return getStreamSource({
        data: {
          tmdbId: title.tmdbId,
          type: title.type,
          season: activeSeason?.number,
          episode: activeEpisode?.number,
        },
      });
    },
    enabled: Boolean(title?.tmdbId),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const playlistUrl = streamQuery.data?.playlistUrl ?? null;
  const embedUrl = title?.tmdbId
    ? buildEmbedUrl(player, {
        tmdbId: title.tmdbId,
        type: title.type,
        season: activeSeason?.number,
        episode: activeEpisode?.number,
      })
    : null;

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

  const hlsPlayerRef = useRef<HlsPlayerHandle>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const lastBroadcastMediaRef = useRef<string>("");

  useEffect(() => {
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
    (time: number) => {
      setIsLocalPlaying(true);
      const cur = latestSecondsRef.current ?? 0;
      latestSecondsRef.current = time;
      if (playlistUrl && !hlsFailed) {
        hlsPlayerRef.current?.seek(time);
        hlsPlayerRef.current?.play();
      } else {
        if (Math.abs(cur - time) > 2.5) {
          sendIframePlayerCommand(iframeRef.current, "seek", time);
        }
        sendIframePlayerCommand(iframeRef.current, "play");
      }
    },
    [playlistUrl, hlsFailed],
  );

  const onRemotePause = useCallback(
    (time: number) => {
      setIsLocalPlaying(false);
      latestSecondsRef.current = time;
      if (playlistUrl && !hlsFailed) {
        hlsPlayerRef.current?.pause();
      } else {
        sendIframePlayerCommand(iframeRef.current, "pause");
      }
    },
    [playlistUrl, hlsFailed],
  );

  const onRemoteSeek = useCallback(
    (time: number) => {
      latestSecondsRef.current = time;
      if (playlistUrl && !hlsFailed) {
        hlsPlayerRef.current?.seek(time);
      } else {
        sendIframePlayerCommand(iframeRef.current, "seek", time);
      }
    },
    [playlistUrl, hlsFailed],
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
      }
    },
    [slug, activeSeason, activeEpisode, navigate, partyCode, searchPartyCode],
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
    return isLocalPlaying;
  }, [playlistUrl, hlsFailed, isLocalPlaying]);

  const onRoomNotFound = useCallback(() => {
    setPartyCode(null);
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

  // Guest auto-synchronizes to host's movie/episode whenever room is loaded or changes
  useEffect(() => {
    if (!party.room || party.isHost) return;
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
      console.info("Syncing guest to host media:", media.slug, targetSeason, targetEpisode);
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
    }
  }, [party.room, party.isHost, slug, activeSeason?.number, activeEpisode?.number, navigate, partyCode, searchPartyCode]);

  // Host broadcasts media changes when switching episodes
  useEffect(() => {
    if (!party.isHost || !party.room || !title) return;
    const mediaKey = `${slug}:${season}:${episode}`;
    if (lastBroadcastMediaRef.current === mediaKey) return;
    lastBroadcastMediaRef.current = mediaKey;
    party.sendChangeMedia(
      {
        slug,
        tmdbId: title.tmdbId,
        type: title.type,
        season: activeSeason?.number,
        episode: activeEpisode?.number,
        titleName: title.name,
      },
      latestSecondsRef.current ?? 0,
    );
  }, [party.isHost, party.room, party.sendChangeMedia, slug, season, episode, title, activeSeason, activeEpisode]);

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
          },
          initialTime,
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
      const targetMedia = res.room.media;
      if (targetMedia && targetMedia.slug) {
        const isDiffSlug = targetMedia.slug !== slug;
        const targetSeason = targetMedia.type === "tv" ? targetMedia.season ?? 1 : undefined;
        const targetEpisode = targetMedia.type === "tv" ? targetMedia.episode ?? 1 : undefined;
        const isDiffEp =
          targetMedia.type === "tv" &&
          (targetSeason !== activeSeason?.number || targetEpisode !== activeEpisode?.number);

        if (isDiffSlug || isDiffEp) {
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

  const handleLeaveParty = () => {
    try {
      sessionStorage.removeItem("cinemagic_watch_party");
    } catch {}
    party.leaveParty();
    setPartyCode(null);
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
  };

  const startSecond = marker ?? undefined;
  const resumeEmbedUrl =
    embedUrl && title?.tmdbId
      ? buildEmbedUrl(player, {
          tmdbId: title.tmdbId,
          type: title.type,
          season: activeSeason?.number,
          episode: activeEpisode?.number,
          startAt: startSecond,
        })
      : null;

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
    };
  }, [slug, title, season, episode]);

  function persistMarker(seconds: number, immediate = false) {
    if (!markerLoaded) return;
    if (playbackDurationSeconds > 0 && seconds >= playbackDurationSeconds) {
      clearCompletedMarker();
      seconds = 0;
    }
    latestSecondsRef.current = seconds;
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    const save = () => {
      saveDebounceRef.current = null;
      if (!title) return;
      const clamped = Math.max(0, Math.round(seconds));
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

  // Listen for player events (play, pause, seek, ended, timeupdate) from embed players (e.g. Vixsrc)
  useEffect(() => {
    if (!markerLoaded) return;

    const handlePlayerMessage = (event: MessageEvent) => {
      if (iframeRef.current?.contentWindow && event.source && event.source !== iframeRef.current.contentWindow) {
        return;
      }

      let data = event.data;

      // Handle string messages
      if (typeof data === "string") {
        const trimmed = data.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try {
            data = JSON.parse(trimmed);
          } catch {
            return;
          }
        } else {
          const lower = trimmed.toLowerCase();
          if (lower === "pause") {
            setIsLocalPlaying(false);
            if (latestSecondsRef.current !== null) {
              persistMarker(latestSecondsRef.current, true);
              if (!party.isRemoteSyncingRef.current && party.room) {
                party.sendPause(latestSecondsRef.current);
              }
            }
            return;
          }
          if (lower === "play" || lower === "playing" || lower === "start") {
            setIsLocalPlaying(true);
            if (latestSecondsRef.current !== null) {
              if (!party.isRemoteSyncingRef.current && party.room) {
                party.sendPlay(latestSecondsRef.current);
              }
            }
            return;
          }
          if (lower === "seeking" || lower === "seek" || lower === "seeked") {
            if (latestSecondsRef.current !== null) {
              persistMarker(latestSecondsRef.current, true);
              if (!party.isRemoteSyncingRef.current && party.room) {
                party.sendSeek(latestSecondsRef.current);
              }
            }
            return;
          }
          if (lower === "ended" || lower === "finish" || lower === "complete") {
            setIsLocalPlaying(false);
            clearCompletedMarker();
            persistMarker(0, true);
            return;
          }
          if (lower.startsWith("time:")) {
            const parsed = parseFloat(lower.slice(5));
            if (Number.isFinite(parsed) && parsed >= 0) {
              persistMarker(parsed, false);
            }
            return;
          }
          return;
        }
      }

      if (!data || typeof data !== "object") return;
      const record = data as PlayerMessagePayload;

      let eventName = "";
      let seconds: number | null = null;
      let totalDuration: number | null = null;

      if (typeof record.event === "object" && record.event !== null) {
        const evObj = record.event;
        if (typeof evObj.event === "string") eventName = evObj.event.toLowerCase();
        if (typeof evObj.currentTime === "number") seconds = evObj.currentTime;
        if (typeof evObj.duration === "number") totalDuration = evObj.duration;
      } else if (typeof record.event === "string") {
        eventName = record.event.toLowerCase();
      }

      if (typeof record.data === "object" && record.data !== null) {
        const dataObj = record.data;
        if (!eventName && typeof dataObj.event === "string") {
          eventName = dataObj.event.toLowerCase();
        }
        if (seconds === null && typeof dataObj.currentTime === "number") {
          seconds = dataObj.currentTime;
        }
        if (totalDuration === null && typeof dataObj.duration === "number") {
          totalDuration = dataObj.duration;
        }
      }

      if (!eventName && typeof record.type === "string" && record.type !== "PLAYER_EVENT") {
        eventName = record.type.toLowerCase();
      }

      // Fallback search for seconds in any payload object
      if (seconds === null) {
        const candidates = [record, record.data, record.event, record.info, record.payload];
        for (const cand of candidates) {
          if (cand && typeof cand === "object") {
            const c = cand as PlayerEventData;
            const val = c.currentTime ?? c.time ?? c.seconds ?? c.position ?? c.value;
            const num =
              typeof val === "number" ? val : typeof val === "string" ? parseFloat(val) : NaN;
            if (Number.isFinite(num) && num >= 0) {
              seconds = num;
              break;
            }
          }
        }
      }

      // Fallback search for total duration
      if (totalDuration === null) {
        const candidates = [record, record.data, record.event, record.info, record.payload];
        for (const cand of candidates) {
          if (cand && typeof cand === "object") {
            const c = cand as PlayerEventData;
            const val = c.duration;
            const num =
              typeof val === "number" ? val : typeof val === "string" ? parseFloat(val) : NaN;
            if (Number.isFinite(num) && num > 0) {
              totalDuration = num;
              break;
            }
          }
        }
      }

      // Handle video completion
      if (eventName === "ended" || eventName === "complete" || eventName === "finish") {
        setIsLocalPlaying(false);
        clearCompletedMarker();
        persistMarker(0, true);
        return;
      }

      const durationLimit = totalDuration || playbackDurationSeconds;
      if (seconds !== null && durationLimit > 0 && seconds >= durationLimit - 10) {
        setIsLocalPlaying(false);
        clearCompletedMarker();
        persistMarker(0, true);
        return;
      }

      // Handle seek events (mouse drag/click on progress bar)
      if (eventName === "seeked" || eventName === "seek") {
        if (seconds !== null && Number.isFinite(seconds) && seconds >= 0) {
          persistMarker(seconds, true);
          if (!party.isRemoteSyncingRef.current && party.room) {
            party.sendSeek(seconds);
          }
        }
        return;
      }

      // Handle pause events
      if (eventName === "pause") {
        setIsLocalPlaying(false);
        if (seconds !== null && Number.isFinite(seconds) && seconds >= 0) {
          persistMarker(seconds, true);
          if (!party.isRemoteSyncingRef.current && party.room) {
            party.sendPause(seconds);
          }
        } else if (latestSecondsRef.current !== null) {
          persistMarker(latestSecondsRef.current, true);
          if (!party.isRemoteSyncingRef.current && party.room) {
            party.sendPause(latestSecondsRef.current);
          }
        }
        return;
      }

      // Handle play events
      if (eventName === "play" || eventName === "playing" || eventName === "start") {
        setIsLocalPlaying(true);
        if (seconds !== null && Number.isFinite(seconds) && seconds >= 0) {
          latestSecondsRef.current = seconds;
          if (!party.isRemoteSyncingRef.current && party.room) {
            party.sendPlay(seconds);
          }
        } else if (latestSecondsRef.current !== null) {
          if (!party.isRemoteSyncingRef.current && party.room) {
            party.sendPlay(latestSecondsRef.current);
          }
        }
        return;
      }

      // Handle timeupdate events (sent continuously while playing)
      if (eventName === "timeupdate" || eventName === "time") {
        if (seconds !== null && Number.isFinite(seconds) && seconds >= 0) {
          persistMarker(seconds, false);
        }
        return;
      }

      // Generic fallback if seconds were extracted
      if (seconds !== null && Number.isFinite(seconds) && seconds >= 0) {
        persistMarker(seconds, false);
      }
    };

    window.addEventListener("message", handlePlayerMessage);
    return () => window.removeEventListener("message", handlePlayerMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerLoaded, slug, title, season, episode, party]);

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

        <div>
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
            initialSeconds={marker ?? undefined}
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
          <div className="aspect-video w-full overflow-hidden rounded-xl border border-border bg-black">
            <iframe
              ref={iframeRef}
              src={resumeEmbedUrl ?? embedUrl}
              title={`${title.name} player`}
              className="size-full"
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
              referrerPolicy="origin"
            />
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
          <div className="flex overflow-x-auto overflow-y-hidden whitespace-nowrap -mx-1 px-1 scrollbar-none sm:overflow-visible sm:whitespace-normal">
            {title.seasons.map((sn) => (
              <Link
                key={sn.number}
                to="/watch/$id"
                params={{ id }}
                search={{ s: sn.number, e: undefined, party: partyCode ?? undefined }}
                className={`rounded-full border px-4 py-1.5 text-xs font-medium transition-colors ${
                  sn.number === activeSeason.number
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:border-primary/50"
                }`}
              >
                {sn.name}
              </Link>
            ))}
          </div>
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
