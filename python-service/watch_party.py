"""Watch Together (Guarda Insieme) real-time synchronization backend.

Manages real-time watch party rooms, participant state, chat history, and WebSocket
broadcast events (play, pause, seek, sync drift corrections, media change, and chat).
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import string
import time
from typing import Any, Dict, List, Optional, Set

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field

from auth import bearer, current_account, current_session, Session, token_hash
from db import connect, now

log = logging.getLogger("streaming-dashboard")

router = APIRouter(prefix="/party", tags=["watch-party"])


# --------------------------------------------------------------------------- #
# Helpers & Token Authentication
# --------------------------------------------------------------------------- #

def get_account_from_token(token: str) -> Optional[Dict[str, Any]]:
    """Resolve an account dict from a raw bearer/cookie session token string."""
    if not token:
        return None
    try:
        with connect() as conn:
            row = conn.execute(
                """
                SELECT a.id, a.name, a.role, a.color, a.profile_picture
                FROM sessions s
                JOIN accounts a ON a.id = s.account_id
                WHERE s.token_hash = ? AND s.expires_at > ?
                """,
                (token_hash(token), now()),
            ).fetchone()
            if row:
                return dict(row)
    except Exception as exc:
        log.warning("error validating party token: %s", exc)
    return None


def get_party_account(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer),
) -> Dict[str, Any]:
    """Authenticate user for Watch Together endpoints via Bearer header or HTTP session cookie."""
    if credentials and credentials.scheme.lower() == "bearer" and credentials.credentials:
        acc = get_account_from_token(credentials.credentials)
        if acc:
            return acc
    cookie_token = request.cookies.get("streamapp_session")
    if cookie_token:
        acc = get_account_from_token(cookie_token)
        if acc:
            return acc
    raise HTTPException(status_code=401, detail="Not signed in")


def generate_room_code(length: int = 6) -> str:
    """Generate a friendly, collision-resistant room code like 'CINE-42' or 'WZ8492'."""
    alphabet = string.ascii_uppercase + string.digits
    # Avoid ambiguous characters like 0, O, 1, I
    clean_alphabet = "".join(c for c in alphabet if c not in "0O1I")
    prefix = "".join(secrets.choice(clean_alphabet) for _ in range(length // 2))
    suffix = "".join(secrets.choice(string.digits) for _ in range(length // 2))
    return f"{prefix}{suffix}"


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #

class MediaPayload(BaseModel):
    slug: str
    tmdbId: Optional[int] = None
    type: str  # "movie" or "tv"
    season: Optional[int] = None
    episode: Optional[int] = None
    titleName: Optional[str] = None


class CreatePartyRequest(BaseModel):
    media: MediaPayload
    initialTime: float = Field(default=0.0, ge=0.0)


class PartyMemberInfo(BaseModel):
    id: int
    name: str
    color: str
    profilePicture: Optional[str] = None
    isHost: bool = False


class PartyPlaybackState(BaseModel):
    time: float = 0.0
    isPlaying: bool = False
    lastUpdated: int = 0


class PartyRoomState(BaseModel):
    code: str
    media: MediaPayload
    hostId: int
    members: List[PartyMemberInfo]
    state: PartyPlaybackState
    chatHistory: List[Dict[str, Any]] = []
    createdAt: int


# --------------------------------------------------------------------------- #
# In-Memory Party Room Manager
# --------------------------------------------------------------------------- #

class PartyRoom:
    def __init__(self, code: str, media: MediaPayload, host_account: Dict[str, Any], initial_time: float = 0.0):
        self.code = code
        self.media = media
        self.host_id = host_account["id"]
        self.created_at = int(time.time() * 1000)
        self.state = PartyPlaybackState(
            time=initial_time,
            isPlaying=False,
            lastUpdated=self.created_at,
        )
        self.members: Dict[int, Dict[str, Any]] = {
            host_account["id"]: {
                "id": host_account["id"],
                "name": host_account["name"],
                "color": host_account.get("color", "#6366f1"),
                "profilePicture": host_account.get("profile_picture"),
                "isHost": True,
            }
        }
        # account_id -> set of active WebSockets (supports multiple tabs / reconnects)
        self.connections: Dict[int, Set[WebSocket]] = {}
        # Recent chat messages persisted in memory for participants who join or reconnect
        self.chat_history: List[Dict[str, Any]] = []
        self.lock = asyncio.Lock()

    def get_room_state_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "media": self.media.model_dump(),
            "hostId": self.host_id,
            "members": [
                {
                    "id": m["id"],
                    "name": m["name"],
                    "color": m.get("color", "#6366f1"),
                    "profilePicture": m.get("profilePicture") or m.get("profile_picture"),
                    "isHost": (m["id"] == self.host_id),
                }
                for m in self.members.values()
            ],
            "state": self.state.model_dump(),
            "chatHistory": list(self.chat_history),
            "createdAt": self.created_at,
        }

    async def broadcast(self, message: Dict[str, Any], exclude_account_id: Optional[int] = None):
        """Broadcast a JSON message to all connected participants."""
        payload = json.dumps(message)
        dead_connections = []
        for account_id, sockets in list(self.connections.items()):
            if exclude_account_id and account_id == exclude_account_id:
                continue
            for ws in list(sockets):
                try:
                    await ws.send_text(payload)
                except Exception:
                    dead_connections.append((account_id, ws))

        for account_id, ws in dead_connections:
            if account_id in self.connections:
                self.connections[account_id].discard(ws)
                if not self.connections[account_id]:
                    del self.connections[account_id]


class PartyManager:
    def __init__(self):
        self.rooms: Dict[str, PartyRoom] = {}
        self._lock = asyncio.Lock()

    async def create_room(self, media: MediaPayload, host_account: Dict[str, Any], initial_time: float = 0.0) -> PartyRoom:
        async with self._lock:
            for _ in range(10):
                code = generate_room_code()
                if code not in self.rooms:
                    break
            else:
                code = f"ROOM-{int(time.time()) % 10000}"

            clean_code = code.upper().strip()
            room = PartyRoom(clean_code, media, host_account, initial_time)
            self.rooms[clean_code] = room
            log.info("Watch party created: %s by user %s (%s)", clean_code, host_account["name"], media.titleName)
            return room

    async def get_room(self, code: str) -> Optional[PartyRoom]:
        return self.rooms.get(code.upper().strip())

    async def remove_room_if_empty(self, code: str, delay_seconds: float = 120.0):
        """Wait a grace period (e.g. 120s) before removing an empty room to survive page reloads and brief reconnects."""
        if delay_seconds > 0:
            await asyncio.sleep(delay_seconds)
        async with self._lock:
            clean_code = code.upper().strip()
            room = self.rooms.get(clean_code)
            if room and not room.connections:
                log.info("Cleaning up empty watch party room after grace period: %s", clean_code)
                self.rooms.pop(clean_code, None)


party_manager = PartyManager()


# --------------------------------------------------------------------------- #
# REST Endpoints
# --------------------------------------------------------------------------- #

@router.post("/create", response_model=PartyRoomState)
async def create_party_endpoint(
    body: CreatePartyRequest,
    account: Dict[str, Any] = Depends(get_party_account),
):
    """Create a new Watch Together party room for the specified movie or episode."""
    room = await party_manager.create_room(body.media, account, body.initialTime)
    return room.get_room_state_dict()


@router.get("/{code}", response_model=PartyRoomState)
async def get_party_endpoint(code: str):
    """Retrieve the current state of a Watch Together room."""
    room = await party_manager.get_room(code)
    if not room:
        raise HTTPException(status_code=404, detail="Watch party room not found")
    return room.get_room_state_dict()


# --------------------------------------------------------------------------- #
# WebSocket Endpoint
# --------------------------------------------------------------------------- #

async def handle_party_websocket(websocket: WebSocket, code: str, token: Optional[str] = None):
    """Handles real-time synchronization between participants in a watch party."""
    await websocket.accept()

    # 1. Authenticate user from query param, cookies, or initial AUTH message
    account = None
    if token:
        account = get_account_from_token(token)

    if not account:
        cookie_token = websocket.cookies.get("streamapp_session")
        if cookie_token:
            account = get_account_from_token(cookie_token)

    if not account:
        try:
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=1.5)
            msg = json.loads(raw)
            if msg.get("type") == "AUTH" and msg.get("token"):
                account = get_account_from_token(msg["token"])
        except Exception:
            pass

    if not account:
        await websocket.send_text(json.dumps({"type": "ERROR", "message": "Authentication required"}))
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    # 2. Join the room
    clean_code = code.upper().strip()
    room = await party_manager.get_room(clean_code)
    if not room:
        await websocket.send_text(json.dumps({"type": "ERROR", "message": "Room not found"}))
        await websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
        return

    account_id = account["id"]
    async with room.lock:
        if account_id not in room.connections:
            room.connections[account_id] = set()
        room.connections[account_id].add(websocket)

        # Register or update member info
        room.members[account_id] = {
            "id": account_id,
            "name": account["name"],
            "color": account.get("color", "#6366f1"),
            "profilePicture": account.get("profile_picture"),
            "isHost": (account_id == room.host_id),
        }

    log.info("User %s (%s) connected to party %s", account["name"], account_id, clean_code)

    # 3. Send initial room state (including chat history) to the newly joined client
    await websocket.send_text(json.dumps({
        "type": "ROOM_STATE",
        "data": room.get_room_state_dict(),
        "yourAccountId": account_id,
    }))

    # 4. Notify everyone else that a member joined
    await room.broadcast({
        "type": "MEMBER_JOINED",
        "member": room.members[account_id],
        "members": list(room.members.values()),
    }, exclude_account_id=account_id)

    # 5. Event loop
    try:
        while True:
            data_text = await websocket.receive_text()
            try:
                msg = json.loads(data_text)
            except Exception:
                continue

            event_type = msg.get("type")
            cur_time = float(msg.get("time", room.state.time))

            if event_type == "PLAY":
                async with room.lock:
                    room.state.isPlaying = True
                    room.state.time = cur_time
                    room.state.lastUpdated = int(time.time() * 1000)
                await room.broadcast({
                    "type": "PLAY",
                    "time": cur_time,
                    "senderId": account_id,
                    "senderName": account["name"],
                }, exclude_account_id=account_id)

            elif event_type == "PAUSE":
                async with room.lock:
                    room.state.isPlaying = False
                    room.state.time = cur_time
                    room.state.lastUpdated = int(time.time() * 1000)
                await room.broadcast({
                    "type": "PAUSE",
                    "time": cur_time,
                    "senderId": account_id,
                    "senderName": account["name"],
                }, exclude_account_id=account_id)

            elif event_type == "SEEK":
                async with room.lock:
                    room.state.time = cur_time
                    room.state.lastUpdated = int(time.time() * 1000)
                await room.broadcast({
                    "type": "SEEK",
                    "time": cur_time,
                    "senderId": account_id,
                    "senderName": account["name"],
                }, exclude_account_id=account_id)

            elif event_type == "SYNC_TICK":
                if account_id == room.host_id:
                    async with room.lock:
                        room.state.time = cur_time
                        room.state.isPlaying = bool(msg.get("isPlaying", room.state.isPlaying))
                        room.state.lastUpdated = int(time.time() * 1000)
                    await room.broadcast({
                        "type": "SYNC_TICK",
                        "time": cur_time,
                        "isPlaying": room.state.isPlaying,
                        "timestamp": room.state.lastUpdated,
                    }, exclude_account_id=account_id)

            elif event_type in ("CHANGE_MEDIA", "MEDIA_CHANGED"):
                new_media_raw = msg.get("media")
                if new_media_raw:
                    try:
                        new_media = MediaPayload(**new_media_raw)
                        time_val = float(msg.get("time", 0.0))
                        async with room.lock:
                            room.media = new_media
                            room.state.time = time_val
                            room.state.isPlaying = False
                            room.state.lastUpdated = int(time.time() * 1000)
                        await room.broadcast({
                            "type": "CHANGE_MEDIA",
                            "media": new_media.model_dump(),
                            "time": time_val,
                            "senderId": account_id,
                            "senderName": account["name"],
                        })
                    except Exception as exc:
                        log.warning("Invalid media payload: %s", exc)

            elif event_type == "CHAT":
                text = str(msg.get("text", "")).strip()[:500]
                if text:
                    chat_msg = {
                        "id": f"{int(time.time() * 1000)}-{secrets.token_hex(4)}",
                        "type": "CHAT",
                        "text": text,
                        "timestamp": int(time.time() * 1000),
                        "sender": {
                            "id": account_id,
                            "name": account["name"],
                            "color": account.get("color", "#6366f1"),
                            "profilePicture": account.get("profile_picture"),
                        },
                    }
                    async with room.lock:
                        room.chat_history.append(chat_msg)
                        if len(room.chat_history) > 100:
                            room.chat_history.pop(0)
                    # Broadcast to everyone including the sender
                    await room.broadcast(chat_msg)

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.warning("WebSocket exception for %s in room %s: %s", account["name"], clean_code, exc)
    finally:
        async with room.lock:
            if account_id in room.connections:
                room.connections[account_id].discard(websocket)
                if not room.connections[account_id]:
                    del room.connections[account_id]
                    # If other members remain connected, update member list
                    if room.connections:
                        room.members.pop(account_id, None)

            # If host disconnected and other active connections exist, elect new host
            if account_id == room.host_id and room.connections:
                active_account_ids = list(room.connections.keys())
                if active_account_ids:
                    next_host_id = active_account_ids[0]
                    room.host_id = next_host_id
                    if next_host_id in room.members:
                        room.members[next_host_id]["isHost"] = True
                        log.info("Elected new host %s for room %s", room.members[next_host_id]["name"], clean_code)
                        await room.broadcast({
                            "type": "HOST_CHANGED",
                            "newHostId": next_host_id,
                            "members": list(room.members.values()),
                        })

        log.info("User %s disconnected from party %s", account["name"], clean_code)

        # Notify remaining members
        await room.broadcast({
            "type": "MEMBER_LEFT",
            "memberId": account_id,
            "members": list(room.members.values()),
        })

        # Remove room after grace period if completely empty
        if not room.connections:
            asyncio.create_task(party_manager.remove_room_if_empty(clean_code, delay_seconds=120.0))
