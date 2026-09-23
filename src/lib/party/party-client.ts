import { useCallback, useEffect, useRef, useState } from "react";

import { getPartyToken } from "./party.functions";
import type { ChatMessage, PartyEvent, PartyMedia, PartyMember, WatchPartyRoom } from "./types";

interface UseWatchPartyOptions {
  roomCode: string | null;
  onRemotePlay?: (time: number) => void;
  onRemotePause?: (time: number) => void;
  onRemoteSeek?: (time: number) => void;
  onRemoteMediaChange?: (media: PartyMedia, roomCode?: string) => void;
  getCurrentTime?: () => number;
  getIsPlaying?: () => boolean;
}

export function useWatchParty({
  roomCode,
  onRemotePlay,
  onRemotePause,
  onRemoteSeek,
  onRemoteMediaChange,
  getCurrentTime,
  getIsPlaying,
}: UseWatchPartyOptions) {
  const [room, setRoom] = useState<WatchPartyRoom | null>(null);
  const [members, setMembers] = useState<PartyMember[]>([]);
  const [currentAccountId, setCurrentAccountId] = useState<number | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const isRemoteSyncingRef = useRef(false);
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Store latest callbacks in refs so changing parent handlers never triggers reconnect
  const onRemotePlayRef = useRef(onRemotePlay);
  const onRemotePauseRef = useRef(onRemotePause);
  const onRemoteSeekRef = useRef(onRemoteSeek);
  const onRemoteMediaChangeRef = useRef(onRemoteMediaChange);
  const getCurrentTimeRef = useRef(getCurrentTime);
  const getIsPlayingRef = useRef(getIsPlaying);

  useEffect(() => {
    onRemotePlayRef.current = onRemotePlay;
    onRemotePauseRef.current = onRemotePause;
    onRemoteSeekRef.current = onRemoteSeek;
    onRemoteMediaChangeRef.current = onRemoteMediaChange;
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

  // Send raw payload over WS if open
  const sendEvent = useCallback((event: Record<string, unknown>) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(event));
    }
  }, []);

  const sendPlay = useCallback((time: number) => {
    if (isRemoteSyncingRef.current) return;
    sendEvent({ type: "PLAY", time });
  }, [sendEvent]);

  const sendPause = useCallback((time: number) => {
    if (isRemoteSyncingRef.current) return;
    sendEvent({ type: "PAUSE", time });
  }, [sendEvent]);

  const sendSeek = useCallback((time: number) => {
    if (isRemoteSyncingRef.current) return;
    sendEvent({ type: "SEEK", time });
  }, [sendEvent]);

  const sendSyncTick = useCallback((time: number, isPlaying: boolean) => {
    sendEvent({ type: "SYNC_TICK", time, isPlaying });
  }, [sendEvent]);

  const sendChangeMedia = useCallback((media: PartyMedia, time = 0) => {
    sendEvent({ type: "CHANGE_MEDIA", media, time });
  }, [sendEvent]);

  const sendChat = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      sendEvent({ type: "CHAT", text: trimmed });
    } else {
      console.warn("Watch Party WebSocket not connected. Cannot send chat message.");
    }
  }, [sendEvent]);

  // Connect to the room WebSocket (depends ONLY on roomCode)
  useEffect(() => {
    if (!roomCode) {
      if (wsRef.current) {
        wsRef.current.close(1000);
        wsRef.current = null;
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
    setIsConnecting(true);
    setError(null);

    async function initWs() {
      try {
        const token = await getPartyToken();
        if (!active) return;
        if (!token) {
          setError("Devi effettuare l'accesso per unirti al Watch Party");
          setIsConnecting(false);
          return;
        }

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${protocol}//${window.location.host}/ws/party/${encodeURIComponent(roomCode!.trim().toUpperCase())}?token=${encodeURIComponent(token)}`;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!active) {
            ws.close(1000);
            return;
          }
          setIsConnected(true);
          setIsConnecting(false);
          setError(null);
        };

        ws.onmessage = (event) => {
          if (!active) return;
          try {
            const data: PartyEvent = JSON.parse(event.data);
            handlePartyEvent(data);
          } catch (e) {
            console.error("Failed to parse party message:", e);
          }
        };

        ws.onerror = (err) => {
          console.error("Watch party WebSocket error:", err);
          if (active) {
            setIsConnecting(false);
          }
        };

        ws.onclose = (event) => {
          if (!active) return;
          setIsConnected(false);
          setIsConnecting(false);
          if (event.code === 1008) {
            setError("Autenticazione richiesta o fallita");
          } else if (event.code === 1000) {
            // Normal close
          } else {
            // Transient closure - try to reconnect if still active
            reconnectTimer = setTimeout(() => {
              if (active) {
                initWs();
              }
            }, 2500);
          }
        };
      } catch (err) {
        if (active) {
          setIsConnecting(false);
          setError("Impossibile connettersi al server del Watch Party");
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
          withRemoteSync(() => {
            if (onRemoteSeekRef.current) onRemoteSeekRef.current(msg.time);
          });
          setRoom((prev) =>
            prev ? { ...prev, state: { ...prev.state, time: msg.time, lastUpdated: Date.now() } } : null,
          );
          break;
        }
        case "SYNC_TICK": {
          if (room && currentAccountId !== room.hostId && getCurrentTimeRef.current) {
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
            // Avoid duplicate message by id if already present
            if (msg.id && prev.some((m) => m.id === msg.id)) {
              return prev;
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
          break;
        }
      }
    }

    initWs();

    return () => {
      active = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (wsRef.current) {
        wsRef.current.close(1000);
        wsRef.current = null;
      }
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
    };
  }, [roomCode, withRemoteSync]);

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

  const leaveParty = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close(1000);
      wsRef.current = null;
    }
    setRoom(null);
    setMembers([]);
    setIsConnected(false);
    setError(null);
    setChatMessages([]);
  }, []);

  return {
    room,
    members,
    currentAccountId,
    isHost,
    isConnected,
    isConnecting,
    error,
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
