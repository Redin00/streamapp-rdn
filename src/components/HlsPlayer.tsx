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
          v.play().catch(() => {});
        }
      },
      pause: () => {
        const v = videoRef.current;
        if (v && !v.paused) {
          v.pause();
        }
      },
      seek: (seconds: number) => {
        const v = videoRef.current;
        if (v && Number.isFinite(seconds) && seconds >= 0) {
          v.currentTime = seconds;
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
      const target = initialSecondsRef.current;
      if (target !== undefined && target > 0 && video.duration > 0) {
        video.currentTime = target;
      }
    };

    if (initialSecondsRef.current !== undefined && initialSecondsRef.current > 0) {
      if (video.readyState >= 3) {
        applySeek();
        return;
      }
      const onCanPlay = () => {
        if (removed) return;
        removed = true;
        applySeek();
        video.removeEventListener("canplay", onCanPlay);
      };
      video.addEventListener("canplay", onCanPlay);
      return () => {
        removed = true;
        video.removeEventListener("canplay", onCanPlay);
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
    let seekedHandler: ((event: Event) => void) | null = null;
    let endedHandler: (() => void) | null = null;

    const applyInitialSeek = () => {
      const target = initialSecondsRef.current;
      if (target !== undefined && target > 0 && video.duration > 0) {
        video.currentTime = target;
      }
    };

    const playNatively = () => {
      nativeError = () => onFatalRef.current?.();
      video.addEventListener("error", nativeError);
      video.src = src;
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
      onPlayRef.current?.(video.currentTime);
    };
    pauseHandler = () => {
      onPauseRef.current?.(video.currentTime);
    };
    seekedHandler = () => {
      onSeekRef.current?.(video.currentTime);
    };
    endedHandler = () => onTimeUpdateRef.current?.(0);

    video.addEventListener("timeupdate", timeHandler);
    video.addEventListener("play", playHandler);
    video.addEventListener("pause", pauseHandler);
    video.addEventListener("seeked", seekedHandler);
    video.addEventListener("ended", endedHandler);

    return () => {
      cancelled = true;
      hls?.destroy();
      if (nativeError) {
        video.removeEventListener("error", nativeError);
        video.removeAttribute("src");
        video.load();
      }
      if (timeHandler) video.removeEventListener("timeupdate", timeHandler);
      if (playHandler) video.removeEventListener("play", playHandler);
      if (pauseHandler) video.removeEventListener("pause", pauseHandler);
      if (seekedHandler) video.removeEventListener("seeked", seekedHandler);
      if (endedHandler) video.removeEventListener("ended", endedHandler);
    };
  }, [src]);

  return <video ref={videoRef} controls playsInline className="size-full" title={title} />;
});
