import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

// Type-only, so hls.js stays out of the server bundle and out of the entry chunk.
import type Hls from "hls.js";

export interface HlsPlayerHandle {
  play: () => Promise<void> | void;
  pause: () => void;
  seek: (seconds: number) => void;
  getCurrentTime: () => number;
  getIsPlaying: () => boolean;
}

export interface HlsPlayerProps {
  src: string;
  title: string;
  /** Called when playback cannot recover, so the caller can fall back to the embed. */
  onFatal?: () => void;
  /** Called periodically while the video plays, with the current playback position in seconds. */
  onTimeUpdate?: (seconds: number) => void;
  /** Called when local playback starts. */
  onPlay?: (seconds: number) => void;
  /** Called when local playback pauses. */
  onPause?: (seconds: number) => void;
  /** Called when local playback position is sought. */
  onSeek?: (seconds: number) => void;
  /** Seconds to seek to once the media is ready and playing. Pass `undefined` to skip. */
  initialSeconds?: number | undefined;
}

export const HlsPlayer = forwardRef<HlsPlayerHandle, HlsPlayerProps>(function HlsPlayer(
  { src, title, onFatal, onTimeUpdate, onPlay, onPause, onSeek, initialSeconds }: HlsPlayerProps,
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onFatalRef = useRef(onFatal);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const onPlayRef = useRef(onPlay);
  const onPauseRef = useRef(onPause);
  const onSeekRef = useRef(onSeek);
  const initialSecondsRef = useRef(initialSeconds);
  const pendingSeekRef = useRef<number | null>(null);
  const suppressEventsUntilRef = useRef<number>(0);

  useEffect(() => {
    onFatalRef.current = onFatal;
  }, [onFatal]);

  useEffect(() => {
    onTimeUpdateRef.current = onTimeUpdate;
  }, [onTimeUpdate]);

  useEffect(() => {
    onPlayRef.current = onPlay;
  }, [onPlay]);

  useEffect(() => {
    onPauseRef.current = onPause;
  }, [onPause]);

  useEffect(() => {
    onSeekRef.current = onSeek;
  }, [onSeek]);

  useEffect(() => {
    initialSecondsRef.current = initialSeconds;
  }, [initialSeconds]);

  useImperativeHandle(
    ref,
    () => ({
      play: () => {
        const v = videoRef.current;
        if (v && v.paused) {
          suppressEventsUntilRef.current = Date.now() + 800;
          v.play().catch(() => {});
        }
      },
      pause: () => {
        const v = videoRef.current;
        if (v && !v.paused) {
          suppressEventsUntilRef.current = Date.now() + 800;
          v.pause();
        }
      },
      seek: (seconds: number) => {
        const v = videoRef.current;
        if (v && Number.isFinite(seconds) && seconds >= 0) {
          suppressEventsUntilRef.current = Date.now() + 1000;
          if (v.readyState >= 1) {
            try {
              v.currentTime = seconds;
              pendingSeekRef.current = null;
            } catch {
              pendingSeekRef.current = seconds;
            }
          } else {
            pendingSeekRef.current = seconds;
          }
        }
      },
      getCurrentTime: () => {
        return videoRef.current?.currentTime || 0;
      },
      getIsPlaying: () => {
        return Boolean(videoRef.current && !videoRef.current.paused);
      },
    }),
    [],
  );

  // When initialSeconds changes after mount (e.g. the marker arrives async
  // after canplay has already fired), re-apply the seek once the media is
  // ready for it. This is the only seek path — the old check for video.src
  // was dead for HLS because hls.js never sets video.src.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let removed = false;
    const applySeek = () => {
      const target = pendingSeekRef.current ?? initialSecondsRef.current;
      if (target !== undefined && target >= 0) {
        try {
          suppressEventsUntilRef.current = Date.now() + 1000;
          video.currentTime = target;
          pendingSeekRef.current = null;
        } catch {
          // Wait for canplay if currentTime assignment fails on early readyState
        }
      }
    };

    if (initialSecondsRef.current !== undefined && initialSecondsRef.current >= 0) {
      if (video.readyState >= 1) {
        applySeek();
        return;
      }
      const onReady = () => {
        if (removed) return;
        removed = true;
        applySeek();
        video.removeEventListener("loadedmetadata", onReady);
        video.removeEventListener("canplay", onReady);
      };
      video.addEventListener("loadedmetadata", onReady);
      video.addEventListener("canplay", onReady);
      return () => {
        removed = true;
        video.removeEventListener("loadedmetadata", onReady);
        video.removeEventListener("canplay", onReady);
      };
    }
    return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSeconds]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    let cancelled = false;
    let nativeError: (() => void) | null = null;
    let timeHandler: ((event: Event) => void) | null = null;
    let playHandler: ((event: Event) => void) | null = null;
    let pauseHandler: ((event: Event) => void) | null = null;
    let seekingHandler: ((event: Event) => void) | null = null;
    let seekedHandler: ((event: Event) => void) | null = null;
    let endedHandler: (() => void) | null = null;
    let pauseDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    const applyInitialSeek = () => {
      const target = pendingSeekRef.current ?? initialSecondsRef.current;
      if (target !== undefined && target > 0) {
        try {
          suppressEventsUntilRef.current = Date.now() + 1000;
          video.currentTime = target;
          pendingSeekRef.current = null;
        } catch {}
      }
    };

    const playNatively = () => {
      nativeError = () => onFatalRef.current?.();
      video.addEventListener("error", nativeError);
      video.src = src;
      video.addEventListener(
        "loadedmetadata",
        () => {
          if (!cancelled) applyInitialSeek();
        },
        { once: true },
      );
      video.addEventListener(
        "canplay",
        () => {
          if (!cancelled) applyInitialSeek();
        },
        { once: true },
      );
    };

    void (async () => {
      const { default: HlsClient } = await import("hls.js");
      if (cancelled) return;

      if (!HlsClient.isSupported()) {
        playNatively();
        return;
      }

      hls = new HlsClient({ enableWorker: true });
      hls.on(HlsClient.Events.ERROR, (_event, data) => {
        if (!data.fatal || !hls) return;
        if (data.type === HlsClient.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else onFatalRef.current?.();
      });
      hls.loadSource(src);
      hls.attachMedia(video);

      video.addEventListener(
        "canplay",
        () => {
          if (!cancelled) applyInitialSeek();
        },
        { once: true },
      );
    })();

    timeHandler = () => {
      const handler = onTimeUpdateRef.current;
      if (handler) handler(video.currentTime);
    };
    playHandler = () => {
      if (pauseDebounceTimer) {
        clearTimeout(pauseDebounceTimer);
        pauseDebounceTimer = null;
      }
      if (Date.now() < suppressEventsUntilRef.current) return;
      onPlayRef.current?.(video.currentTime);
    };
    pauseHandler = () => {
      if (Date.now() < suppressEventsUntilRef.current) return;
      if (video.seeking) return;
      if (pauseDebounceTimer) clearTimeout(pauseDebounceTimer);
      pauseDebounceTimer = setTimeout(() => {
        pauseDebounceTimer = null;
        if (!video.paused || video.seeking || Date.now() < suppressEventsUntilRef.current) return;
        onPauseRef.current?.(video.currentTime);
      }, 250);
    };
    seekingHandler = () => {
      if (pauseDebounceTimer) {
        clearTimeout(pauseDebounceTimer);
        pauseDebounceTimer = null;
      }
    };
    seekedHandler = () => {
      if (pauseDebounceTimer) {
        clearTimeout(pauseDebounceTimer);
        pauseDebounceTimer = null;
      }
      if (Date.now() < suppressEventsUntilRef.current) return;
      onSeekRef.current?.(video.currentTime);
    };
    endedHandler = () => onTimeUpdateRef.current?.(0);

    video.addEventListener("timeupdate", timeHandler);
    video.addEventListener("play", playHandler);
    video.addEventListener("pause", pauseHandler);
    video.addEventListener("seeking", seekingHandler);
    video.addEventListener("seeked", seekedHandler);
    video.addEventListener("ended", endedHandler);

    return () => {
      cancelled = true;
      if (pauseDebounceTimer) clearTimeout(pauseDebounceTimer);
      hls?.destroy();
      if (nativeError) {
        video.removeEventListener("error", nativeError);
        video.removeAttribute("src");
        video.load();
      }
      if (timeHandler) video.removeEventListener("timeupdate", timeHandler);
      if (playHandler) video.removeEventListener("play", playHandler);
      if (pauseHandler) video.removeEventListener("pause", pauseHandler);
      if (seekingHandler) video.removeEventListener("seeking", seekingHandler);
      if (seekedHandler) video.removeEventListener("seeked", seekedHandler);
      if (endedHandler) video.removeEventListener("ended", endedHandler);
    };
  }, [src]);

  return <video ref={videoRef} controls playsInline preload="metadata" className="size-full" title={title} />;
});
