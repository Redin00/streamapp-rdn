import { useCallback, useEffect, useRef, useState } from "react";

import {
  getPartyConnectionInfo,
  leavePartyRoom,
  pollPartyRoom,
  sendPartyEvent,
} from "./party.functions";
import type { ChatMessage, PartyEvent, PartyMedia, PartyMember, WatchPartyRoom } from "./types";

interface UseWatchPartyOptions {
  roomCode: string | null;
  initialRoom?: WatchPartyRoom | null;
  onRemotePlay?: (time: number) => void;
  onRemotePause?: (time: number) => void;
  onRemoteSeek?: (time: number) => void;
  onRemoteMediaChange?: (media: PartyMedia, roomCode?: string) => void;
  onRoomNotFound?: () => void;
  getCurrentTime?: () => number;
  getIsPlaying?: () => boolean;
}

export function useWatchParty({
  roomCode,
  initialRoom,
  onRemotePlay,
  onRemotePause,
  onRemoteSeek,
  onRemoteMediaChange,
  onRoomNotFound,
  getCurrentTime,
  getIsPlaying,
}: UseWatchPartyOptions) {
  const [room, setRoom] = useState<WatchPartyRoom | null>(initialRoom ?? null);
  const [members, setMembers] = useState<PartyMember[]>(initialRoom?.members ?? []);
  const [currentAccountId, setCurrentAccountId] = useState<number | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialRoom?.chatHistory ?? []);

  const wsRef = useRef<WebSocket | null>(null);
  const wsConnectedRef = useRef(false);
  const isPollingRef = useRef(false);
  const isRemoteSyncingRef = useRef(false);
  const isDeadRoomRef = useRef(false);
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentAccountIdRef = useRef<number | null>(null);
  currentAccountIdRef.current = currentAccountId;

  const lastEventTsRef = useRef<number>(initialRoom?.createdAt ?? Date.now() - 5000);

  // Sync initialRoom when passed or updated from caller
  useEffect(() => {
    if (initialRoom && initialRoom.code === roomCode) {
      setRoom(initialRoom);
      setMembers(initialRoom.members);
      if (Array.isArray(initialRoom.chatHistory)) {
        setChatMessages(initialRoom.chatHistory);
      }
    }
  }, [initialRoom, roomCode]);

  // Store latest callbacks in refs so changing parent handlers never triggers reconnect
  const onRemotePlayRef = useRef(onRemotePlay);
  const onRemotePauseRef = useRef(onRemotePause);
  const onRemoteSeekRef = useRef(onRemoteSeek);
  const onRemoteMediaChangeRef = useRef(onRemoteMediaChange);
  const onRoomNotFoundRef = useRef(onRoomNotFound);
  const getCurrentTimeRef = useRef(getCurrentTime);
  const getIsPlayingRef = useRef(getIsPlaying);

  useEffect(() => {
    onRemotePlayRef.current = onRemotePlay;
    onRemotePauseRef.current = onRemotePause;
    onRemoteSeekRef.current = onRemoteSeek;
    onRemoteMediaChangeRef.current = onRemoteMediaChange;
    onRoomNotFoundRef.current = onRoomNotFound;
    getCurrentTimeRef.current = getCurrentTime;
    getIsPlayingRef.current = getIsPlaying;
  });

  // Helper to suppress local event emission while applying a remote event
  const withRemoteSync = useCallback((callback: () => void, durationMs = 700) => {
    isRemoteSyncingRef.current = true;
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
    }
    try {
      callback();
    } finally {
      syncTimeoutRef.current = setTimeout(() => {
        isRemoteSyncingRef.current = false;
      }, durationMs);
    }
  }, []);

  const isHost = Boolean(
    room && currentAccountId !== null && room.hostId === currentAccountId,
  );

  // Dual-mode send: uses WebSocket if open, falls back to HTTP POST
  const sendEvent = useCallback(
    async (event: Record<string, unknown>) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(event));
      } else if (roomCode) {
        try {
          const res = await sendPartyEvent({
            data: {
              code: roomCode.trim().toUpperCase(),
              event,
            },
          });
          if (res.ok && res.room) {
            setRoom(res.room);
            setMembers(res.room.members);
          }
        } catch (e) {
          console.error("Failed to send party event via HTTP:", e);
        }
      }
    },
    [roomCode],
  );

  const sendPlay = useCallback(
    (time: number) => {
      if (isRemoteSyncingRef.current) return;
      void sendEvent({ type: "PLAY", time });
    },
    [sendEvent],
  );

  const sendPause = useCallback(
    (time: number) => {
      if (isRemoteSyncingRef.current) return;
      void sendEvent({ type: "PAUSE", time });
    },
    [sendEvent],
  );

  const sendSeek = useCallback(
    (time: number) => {
      if (isRemoteSyncingRef.current) return;
      void sendEvent({ type: "SEEK", time });
    },
    [sendEvent],
  );

  const sendSyncTick = useCallback(
    (time: number, isPlaying: boolean) => {
      void sendEvent({ type: "SYNC_TICK", time, isPlaying });
    },
    [sendEvent],
  );

  const sendChangeMedia = useCallback(
    (media: PartyMedia, time = 0) => {
      void sendEvent({ type: "CHANGE_MEDIA", media, time });
    },
    [sendEvent],
  );

  const sendChat = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        void sendEvent({ type: "CHAT", text: trimmed });
      } else if (roomCode) {
        // Optimistically display chat message immediately for instant feedback
        const myId = currentAccountIdRef.current ?? 0;
        const myMember = members.find((m) => m.id === myId);
        const optimisticMsg: ChatMessage = {
          id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          text: trimmed,
          sender: {
            id: myId,
            name: myMember?.name ?? "Tu",
            color: myMember?.color ?? "#6366f1",
            profilePicture: myMember?.profilePicture,
          },
          timestamp: Date.now(),
        };
        setChatMessages((prev) => [...prev, optimisticMsg]);
        await sendEvent({ type: "CHAT", text: trimmed });
      }
    },
    [sendEvent, roomCode, members],
  );

  // Connect to the room (Dual-Mode: WebSocket primary + HTTP polling fallback)
  useEffect(() => {
    if (!roomCode) {
      if (wsRef.current) {
        wsRef.current.close(1000);
        wsRef.current = null;
      }
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
      }
      setRoom(null);
      setMembers([]);
      setIsConnected(false);
      setIsConnecting(false);
      setError(null);
      setChatMessages([]);
      return;
    }

    let active = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    isDeadRoomRef.current = false;
    wsConnectedRef.current = false;
    isPollingRef.current = false;
    setIsConnecting(true);
    setError(null);
    lastEventTsRef.current = initialRoom?.createdAt ?? Date.now() - 5000;

    const cleanCode = roomCode.trim().toUpperCase();

    function startHttpPolling() {
      if (!active || isDeadRoomRef.current || isPollingRef.current) return;
      isPollingRef.current = true;
      console.info("Watch party: activating HTTP sync fallback for room", cleanCode);

      async function doPoll() {
        if (!active || isDeadRoomRef.current) {
          isPollingRef.current = false;
          return;
        }

        try {
          const res = await pollPartyRoom({
            data: {
              code: cleanCode,
              since: lastEventTsRef.current,
            },
          });

          if (!active || isDeadRoomRef.current) {
            isPollingRef.current = false;
            return;
          }

          if (res.ok && res.data) {
            setIsConnected(true);
            setIsConnecting(false);
            setError(null);

            const data = res.data;
            if (data.yourAccountId !== undefined) {
              setCurrentAccountId((prev) => prev ?? data.yourAccountId);
            }
            if (data.room) {
              setRoom(data.room);
              setMembers(data.room.members);
              if (Array.isArray(data.room.chatHistory) && data.room.chatHistory.length > 0) {
                setChatMessages((prev) => {
                  const existingIds = new Set(prev.map((m) => m.id));
                  const newMsgs = (data.room.chatHistory || []).filter((m) => !existingIds.has(m.id));
                  return newMsgs.length > 0 ? [...prev, ...newMsgs] : prev;
                });
              }
            }

            if (Array.isArray(data.events) && data.events.length > 0) {
              for (const ev of data.events) {
                if (ev && typeof ev === "object" && "timestamp" in ev && typeof ev.timestamp === "number") {
                  lastEventTsRef.current = Math.max(lastEventTsRef.current, ev.timestamp);
                }
                handlePartyEvent(ev);
              }
            }
          } else if (res.message) {
            const lower = res.message.toLowerCase();
            if (lower.includes("not found") || lower.includes("non trovat") || lower.includes("scadut")) {
              isDeadRoomRef.current = true;
              isPollingRef.current = false;
              setIsConnected(false);
              setIsConnecting(false);
              setError(res.message);
              try {
                sessionStorage.removeItem("cinemagic_watch_party");
              } catch {}
              onRoomNotFoundRef.current?.();
              return;
            }
          }
        } catch (err) {
          console.warn("Watch party HTTP poll error:", err);
        }

        if (active && !isDeadRoomRef.current) {
          // If WS is open, poll rarely as fallback backup; otherwise poll every 1.5s
          const nextDelay = wsConnectedRef.current ? 10000 : 1500;
          pollTimerRef.current = setTimeout(doPoll, nextDelay);
        } else {
          isPollingRef.current = false;
        }
      }

      void doPoll();
    }

    async function initWs() {
      try {
        let token: string | null = null;
        let scBaseUrl: string | null = null;
        let scPort = "8000";

        try {
          const info = await getPartyConnectionInfo();
          token = info.token;
          scBaseUrl = info.scBaseUrl;
          scPort = info.scPort || "8000";
        } catch {
          // Ignore, fallback to cookie authentication
        }
        if (!active || isDeadRoomRef.current) return;

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";

        // 1. Determine primary WebSocket host
        let primaryHost = window.location.host;
        if (scBaseUrl) {
          try {
            const parsed = new URL(scBaseUrl);
            primaryHost = parsed.host;
          } catch {}
        }

        const wsUrl = `${protocol}//${primaryHost}/ws/party/${encodeURIComponent(cleanCode)}${tokenQuery}`;

        let attemptedDirectFallback = false;

        function tryConnect(url: string) {
          if (!active || isDeadRoomRef.current) return;
          const ws = new WebSocket(url);
          wsRef.current = ws;

          ws.onopen = () => {
            if (!active || isDeadRoomRef.current) {
              ws.close(1000);
              return;
            }
            wsConnectedRef.current = true;
            setIsConnected(true);
            setIsConnecting(false);
            setError(null);
          };

          ws.onmessage = (event) => {
            if (!active || isDeadRoomRef.current) return;
            try {
              const data: PartyEvent = JSON.parse(event.data);
              handlePartyEvent(data);
            } catch (e) {
              console.error("Failed to parse party message:", e);
            }
          };

          ws.onerror = (err) => {
            console.error("Watch party WebSocket error connecting to", url, err);
            // If primary host failed on non-standard port, try direct port fallback
            if (
              !attemptedDirectFallback &&
              window.location.port &&
              window.location.port !== scPort &&
              !scBaseUrl
            ) {
              attemptedDirectFallback = true;
              const directPortUrl = `${protocol}//${window.location.hostname}:${scPort}/ws/party/${encodeURIComponent(cleanCode)}${tokenQuery}`;
              console.info("Trying direct port fallback for Watch Party:", directPortUrl);
              tryConnect(directPortUrl);
              return;
            }
            // Trigger HTTP polling immediately when WebSocket fails
            if (active && !isDeadRoomRef.current) {
              startHttpPolling();
            }
          };

          ws.onclose = (event) => {
            wsConnectedRef.current = false;
            if (!active) return;
            if (isDeadRoomRef.current) {
              setIsConnected(false);
              setIsConnecting(false);
              return;
            }
            if (event.code === 1008) {
              setIsConnected(false);
              setIsConnecting(false);
              setError("Autenticazione richiesta o fallita");
              return;
            }

            // Immediately engage HTTP polling fallback so client is never disconnected
            startHttpPolling();

            if (event.code !== 1000) {
              // Background reconnect attempt for WebSocket
              reconnectTimer = setTimeout(() => {
                if (active && !isDeadRoomRef.current && !wsConnectedRef.current) {
                  initWs();
                }
              }, 5000);
            }
          };
        }

        tryConnect(wsUrl);

        // Safety fallback timer: if WebSocket is not connected within 1.5s, start HTTP polling
        fallbackTimerRef.current = setTimeout(() => {
          if (active && !wsConnectedRef.current && !isDeadRoomRef.current) {
            startHttpPolling();
          }
        }, 1500);
      } catch (err) {
        if (active && !isDeadRoomRef.current) {
          startHttpPolling();
        }
      }
    }

    function handlePartyEvent(msg: PartyEvent) {
      switch (msg.type) {
        case "ROOM_STATE": {
          setRoom(msg.data);
          setMembers(msg.data.members);
          setCurrentAccountId(msg.yourAccountId);
          if (Array.isArray(msg.data.chatHistory)) {
            setChatMessages(msg.data.chatHistory);
          }

          // If member is not host, synchronize media and initial playback state
          if (msg.yourAccountId !== msg.data.hostId) {
            if (onRemoteMediaChangeRef.current) {
              onRemoteMediaChangeRef.current(msg.data.media, msg.data.code);
            }
            withRemoteSync(() => {
              if (onRemoteSeekRef.current) onRemoteSeekRef.current(msg.data.state.time);
              if (msg.data.state.isPlaying) {
                if (onRemotePlayRef.current) onRemotePlayRef.current(msg.data.state.time);
              } else {
                if (onRemotePauseRef.current) onRemotePauseRef.current(msg.data.state.time);
              }
            }, 1000);
          }
          break;
        }
        case "MEMBER_JOINED": {
          setMembers(msg.members);
          break;
        }
        case "MEMBER_LEFT": {
          setMembers(msg.members);
          break;
        }
        case "HOST_CHANGED": {
          setRoom((prev) => (prev ? { ...prev, hostId: msg.newHostId } : null));
          setMembers(msg.members);
          break;
        }
        case "PLAY": {
          // Do not re-seek if this client was the sender
          if ("senderId" in msg && currentAccountIdRef.current && msg.senderId === currentAccountIdRef.current) {
            break;
          }
          withRemoteSync(() => {
            if (onRemoteSeekRef.current) onRemoteSeekRef.current(msg.time);
            if (onRemotePlayRef.current) onRemotePlayRef.current(msg.time);
          });
          setRoom((prev) =>
            prev ? { ...prev, state: { ...prev.state, isPlaying: true, time: msg.time, lastUpdated: Date.now() } } : null,
          );
          break;
        }
        case "PAUSE": {
          if ("senderId" in msg && currentAccountIdRef.current && msg.senderId === currentAccountIdRef.current) {
            break;
          }
          withRemoteSync(() => {
            if (onRemoteSeekRef.current) onRemoteSeekRef.current(msg.time);
            if (onRemotePauseRef.current) onRemotePauseRef.current(msg.time);
          });
          setRoom((prev) =>
            prev ? { ...prev, state: { ...prev.state, isPlaying: false, time: msg.time, lastUpdated: Date.now() } } : null,
          );
          break;
        }
        case "SEEK": {
          if ("senderId" in msg && currentAccountIdRef.current && msg.senderId === currentAccountIdRef.current) {
            break;
          }
          withRemoteSync(() => {
            if (onRemoteSeekRef.current) onRemoteSeekRef.current(msg.time);
          });
          setRoom((prev) =>
            prev ? { ...prev, state: { ...prev.state, time: msg.time, lastUpdated: Date.now() } } : null,
          );
          break;
        }
        case "SYNC_TICK": {
          if (room && currentAccountIdRef.current !== room.hostId && getCurrentTimeRef.current) {
            const current = getCurrentTimeRef.current();
            const diff = Math.abs(current - msg.time);
            if (diff > 2.5) {
              withRemoteSync(() => {
                if (onRemoteSeekRef.current) onRemoteSeekRef.current(msg.time);
                if (msg.isPlaying && onRemotePlayRef.current) onRemotePlayRef.current(msg.time);
                if (!msg.isPlaying && onRemotePauseRef.current) onRemotePauseRef.current(msg.time);
              });
            }
          }
          break;
        }
        case "CHANGE_MEDIA": {
          if ("senderId" in msg && currentAccountIdRef.current && msg.senderId === currentAccountIdRef.current) {
            break;
          }
          if (onRemoteMediaChangeRef.current) {
            onRemoteMediaChangeRef.current(msg.media, roomCode || undefined);
          }
          setRoom((prev) =>
            prev ? { ...prev, media: msg.media, state: { isPlaying: false, time: msg.time, lastUpdated: Date.now() } } : null,
          );
          break;
        }
        case "CHAT": {
          setChatMessages((prev) => {
            if (msg.id && prev.some((m) => m.id === msg.id)) {
              return prev;
            }
            // Check if there's an optimistic message with same text from same sender
            const hasSimilarOptimistic = prev.some(
              (m) =>
                m.sender.id === msg.sender.id &&
                m.text === msg.text &&
                Math.abs(m.timestamp - msg.timestamp) < 4000,
            );
            if (hasSimilarOptimistic) {
              return prev.map((m) =>
                m.sender.id === msg.sender.id &&
                m.text === msg.text &&
                Math.abs(m.timestamp - msg.timestamp) < 4000
                  ? { ...m, id: msg.id || m.id }
                  : m,
              );
            }
            return [
              ...prev,
              {
                id: msg.id || `${msg.timestamp}-${Math.random().toString(36).substring(2, 7)}`,
                text: msg.text,
                sender: msg.sender,
                timestamp: msg.timestamp,
              },
            ];
          });
          break;
        }
        case "ERROR": {
          setError(msg.message);
          setIsConnecting(false);
          const lower = (msg.message || "").toLowerCase();
          if (
            lower.includes("not found") ||
            lower.includes("non trovat") ||
            lower.includes("scadut")
          ) {
            isDeadRoomRef.current = true;
            if (reconnectTimer) {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }
            if (pollTimerRef.current) {
              clearTimeout(pollTimerRef.current);
            }
            if (fallbackTimerRef.current) {
              clearTimeout(fallbackTimerRef.current);
            }
            try {
              sessionStorage.removeItem("cinemagic_watch_party");
            } catch {}
            if (onRoomNotFoundRef.current) {
              onRoomNotFoundRef.current();
            }
          }
          break;
        }
      }
    }

    void initWs();

    return () => {
      active = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
      }
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close(1000);
        wsRef.current = null;
      }
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
    };
  }, [roomCode, withRemoteSync, initialRoom]);

  // Host heartbeat / sync tick (broadcast every 4 seconds)
  useEffect(() => {
    if (!isConnected || !isHost || !room) return;

    const interval = setInterval(() => {
      const curTime = getCurrentTimeRef.current ? getCurrentTimeRef.current() : room.state.time;
      const playing = getIsPlayingRef.current ? getIsPlayingRef.current() : room.state.isPlaying;
      sendSyncTick(curTime, playing);
    }, 4000);

    return () => clearInterval(interval);
  }, [isConnected, isHost, room, sendSyncTick]);

  const leaveParty = useCallback(async () => {
    isDeadRoomRef.current = true;
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    if (wsRef.current) {
      wsRef.current.close(1000);
      wsRef.current = null;
    }
    if (roomCode) {
      void leavePartyRoom({
        data: {
          code: roomCode.trim().toUpperCase(),
        },
      });
    }
    setRoom(null);
    setMembers([]);
    setIsConnected(false);
    setIsConnecting(false);
    setError(null);
    setChatMessages([]);
  }, [roomCode]);

  return {
    room,
    setRoom,
    members,
    currentAccountId,
    isHost,
    isConnected,
    isConnecting,
    error,
    setError,
    chatMessages,
    isRemoteSyncingRef,
    withRemoteSync,
    sendPlay,
    sendPause,
    sendSeek,
    sendSyncTick,
    sendChangeMedia,
    sendChat,
    leaveParty,
  };
}
