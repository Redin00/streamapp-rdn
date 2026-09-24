import asyncio
import json
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from auth import create_session, hash_password, token_hash
from db import connect, init_db, now
from main import app
from watch_party import party_manager, MediaPayload


class TestWatchParty(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    def setUp(self):
        self.client = TestClient(app)
        # Create a test account and session
        with connect() as conn:
            conn.execute("DELETE FROM sessions")
            conn.execute("DELETE FROM accounts WHERE name LIKE 'PartyTest%'")
            cursor = conn.execute(
                """
                INSERT INTO accounts (name, password_hash, role, color, created_at)
                VALUES (?, ?, 'member', '#10b981', ?)
                """,
                ("PartyTestUser", hash_password("password123"), now()),
            )
            self.account_id = cursor.lastrowid

            cursor2 = conn.execute(
                """
                INSERT INTO accounts (name, password_hash, role, color, created_at)
                VALUES (?, ?, 'member', '#ef4444', ?)
                """,
                ("PartyTestUser2", hash_password("password123"), now()),
            )
            self.account2_id = cursor2.lastrowid

        self.token = create_session(self.account_id)
        self.token2 = create_session(self.account2_id)
        self.headers = {"Authorization": f"Bearer {self.token}"}
        self.headers2 = {"Authorization": f"Bearer {self.token2}"}

    def test_create_and_get_party(self):
        payload = {
            "media": {
                "slug": "65698-marfil-gli-opposti",
                "tmdbId": 1440098,
                "type": "movie",
                "titleName": "Marfil - Gli Opposti",
            },
            "initialTime": 45.5,
        }
        res = self.client.post("/party/create", json=payload, headers=self.headers)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("code", data)
        code = data["code"]
        self.assertEqual(data["hostId"], self.account_id)
        self.assertEqual(data["media"]["slug"], "65698-marfil-gli-opposti")
        self.assertEqual(data["state"]["time"], 45.5)
        self.assertFalse(data["state"]["isPlaying"])
        self.assertEqual(len(data["members"]), 1)
        self.assertEqual(data["members"][0]["name"], "PartyTestUser")
        self.assertTrue(data["members"][0]["isHost"])

        # Fetch room info via GET /party/{code}
        get_res = self.client.get(f"/party/{code}")
        self.assertEqual(get_res.status_code, 200)
        get_data = get_res.json()
        self.assertEqual(get_data["code"], code)
        self.assertEqual(get_data["hostId"], self.account_id)

    def test_create_party_cookie_auth(self):
        # Create party using cookie without Authorization Bearer header
        payload = {
            "media": {
                "slug": "cookie-room",
                "tmdbId": 1234,
                "type": "movie",
                "titleName": "Cookie Room Title",
            },
            "initialTime": 0.0,
        }
        res = self.client.post("/party/create", json=payload, cookies={"streamapp_session": self.token})
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("code", data)
        self.assertEqual(data["hostId"], self.account_id)

    def test_party_not_found(self):
        res = self.client.get("/party/NONEXISTENT-99")
        self.assertEqual(res.status_code, 404)

    def test_websocket_sync_events(self):
        # 1. Create a party room first
        payload = {
            "media": {
                "slug": "test-movie",
                "tmdbId": 550,
                "type": "movie",
                "titleName": "Fight Club",
            },
            "initialTime": 0.0,
        }
        create_res = self.client.post("/party/create", json=payload, headers=self.headers)
        self.assertEqual(create_res.status_code, 200)
        code = create_res.json()["code"]

        # 2. Connect User 1 (Host) via WebSocket
        with self.client.websocket_connect(f"/ws/party/{code}?token={self.token}") as ws1:
            init_msg = ws1.receive_json()
            self.assertEqual(init_msg["type"], "ROOM_STATE")
            self.assertEqual(init_msg["yourAccountId"], self.account_id)
            self.assertEqual(init_msg["data"]["code"], code)

            # 3. Connect User 2 (Guest) via WebSocket
            with self.client.websocket_connect(f"/ws/party/{code}?token={self.token2}") as ws2:
                # User 2 receives ROOM_STATE
                init2 = ws2.receive_json()
                self.assertEqual(init2["type"], "ROOM_STATE")
                self.assertEqual(init2["yourAccountId"], self.account2_id)

                # User 1 receives MEMBER_JOINED
                joined_event = ws1.receive_json()
                self.assertEqual(joined_event["type"], "MEMBER_JOINED")
                self.assertEqual(joined_event["member"]["id"], self.account2_id)

                # 4. User 1 sends PLAY at second 10.0
                ws1.send_json({"type": "PLAY", "time": 10.0})

                # User 2 receives PLAY
                play_event = ws2.receive_json()
                self.assertEqual(play_event["type"], "PLAY")
                self.assertEqual(play_event["time"], 10.0)
                self.assertEqual(play_event["senderId"], self.account_id)

                # 5. User 2 sends PAUSE at second 25.0
                ws2.send_json({"type": "PAUSE", "time": 25.0})

                # User 1 receives PAUSE
                pause_event = ws1.receive_json()
                self.assertEqual(pause_event["type"], "PAUSE")
                self.assertEqual(pause_event["time"], 25.0)
                self.assertEqual(pause_event["senderId"], self.account2_id)

                # 6. User 1 sends SEEK to minute 5 (300.0s)
                ws1.send_json({"type": "SEEK", "time": 300.0})

                # User 2 receives SEEK
                seek_event = ws2.receive_json()
                self.assertEqual(seek_event["type"], "SEEK")
                self.assertEqual(seek_event["time"], 300.0)

                # 7. User 2 sends CHAT message
                ws2.send_json({"type": "CHAT", "text": "Bella scena!"})

                chat_event = ws1.receive_json()
                self.assertEqual(chat_event["type"], "CHAT")
                self.assertEqual(chat_event["text"], "Bella scena!")
                self.assertEqual(chat_event["sender"]["name"], "PartyTestUser2")

    def test_websocket_cookie_authentication(self):
        # 1. Create a party room first
        payload = {
            "media": {
                "slug": "cookie-test",
                "tmdbId": 123,
                "type": "movie",
                "titleName": "Cookie Movie",
            },
            "initialTime": 0.0,
        }
        create_res = self.client.post("/party/create", json=payload, headers=self.headers)
        self.assertEqual(create_res.status_code, 200)
        code = create_res.json()["code"]

        # 2. Connect via WebSocket with cookie instead of query parameter
        with self.client.websocket_connect(f"/ws/party/{code}", cookies={"streamapp_session": self.token}) as ws:
            init_msg = ws.receive_json()
            self.assertEqual(init_msg["type"], "ROOM_STATE")
            self.assertEqual(init_msg["yourAccountId"], self.account_id)
            self.assertEqual(init_msg["data"]["code"], code)

    def test_http_event_and_poll(self):
        # 1. Create room as User 1
        payload = {
            "media": {
                "slug": "http-sync-test",
                "tmdbId": 999,
                "type": "movie",
                "titleName": "HTTP Test Movie",
            },
            "initialTime": 0.0,
        }
        res = self.client.post("/party/create", json=payload, headers=self.headers)
        self.assertEqual(res.status_code, 200)
        code = res.json()["code"]

        # 2. User 2 posts a CHAT event via HTTP
        chat_payload = {"event": {"type": "CHAT", "text": "Ciao da HTTP!"}}
        event_res = self.client.post(f"/party/{code}/event", json=chat_payload, headers=self.headers2)
        self.assertEqual(event_res.status_code, 200)
        event_data = event_res.json()
        self.assertTrue(event_data["ok"])
        self.assertEqual(event_data["event"]["type"], "CHAT")
        self.assertEqual(event_data["event"]["text"], "Ciao da HTTP!")
        self.assertEqual(event_data["event"]["sender"]["name"], "PartyTestUser2")
        # User 2 is automatically added to members
        member_ids = [m["id"] for m in event_data["room"]["members"]]
        self.assertIn(self.account2_id, member_ids)

        # 3. User 1 polls for events
        poll_res = self.client.get(f"/party/{code}/poll?since=0", headers=self.headers)
        self.assertEqual(poll_res.status_code, 200)
        poll_data = poll_res.json()
        self.assertTrue(poll_data["ok"])
        self.assertEqual(poll_data["yourAccountId"], self.account_id)
        # Should contain MEMBER_JOINED and CHAT
        event_types = [e["type"] for e in poll_data["events"]]
        self.assertIn("MEMBER_JOINED", event_types)
        self.assertIn("CHAT", event_types)

        chat_event_ts = next(e["timestamp"] for e in poll_data["events"] if e["type"] == "CHAT")

        # 4. User 1 posts a PLAY event
        play_res = self.client.post(f"/party/{code}/event", json={"event": {"type": "PLAY", "time": 42.0}}, headers=self.headers)
        self.assertEqual(play_res.status_code, 200)
        self.assertTrue(play_res.json()["room"]["state"]["isPlaying"])
        self.assertEqual(play_res.json()["room"]["state"]["time"], 42.0)

        # 5. User 2 polls with since=chat_event_ts, should only receive PLAY
        poll2 = self.client.get(f"/party/{code}/poll?since={chat_event_ts}", headers=self.headers2)
        self.assertEqual(poll2.status_code, 200)
        poll2_types = [e["type"] for e in poll2.json()["events"]]
        self.assertIn("PLAY", poll2_types)
        self.assertNotIn("CHAT", poll2_types)

    def test_websocket_and_http_interop(self):
        # 1. User 1 creates room and connects via WebSocket
        payload = {
            "media": {
                "slug": "interop-test",
                "tmdbId": 888,
                "type": "movie",
                "titleName": "Interop Movie",
            },
            "initialTime": 0.0,
        }
        res = self.client.post("/party/create", json=payload, headers=self.headers)
        code = res.json()["code"]

        with self.client.websocket_connect(f"/ws/party/{code}?token={self.token}") as ws:
            ws.receive_json()  # ROOM_STATE

            # 2. User 2 sends PLAY via HTTP
            self.client.post(
                f"/party/{code}/event",
                json={"event": {"type": "PLAY", "time": 15.0}},
                headers=self.headers2,
            )

            # User 1 receives MEMBER_JOINED then PLAY over WebSocket in real time!
            msg1 = ws.receive_json()
            self.assertEqual(msg1["type"], "MEMBER_JOINED")
            self.assertEqual(msg1["member"]["id"], self.account2_id)

            msg2 = ws.receive_json()
            self.assertEqual(msg2["type"], "PLAY")
            self.assertEqual(msg2["time"], 15.0)

            # 3. User 1 sends PAUSE via WebSocket
            ws.send_json({"type": "PAUSE", "time": 20.0})
            time.sleep(0.4)

            # 4. User 2 polls via HTTP and sees PAUSE
            poll = self.client.get(f"/party/{code}/poll?since={msg2['timestamp']}", headers=self.headers2)
            events = poll.json()["events"]
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["type"], "PAUSE")
            self.assertEqual(events[0]["time"], 20.0)

    def test_leave_party_http(self):
        payload = {
            "media": {
                "slug": "leave-test",
                "tmdbId": 777,
                "type": "movie",
                "titleName": "Leave Movie",
            },
            "initialTime": 0.0,
        }
        res = self.client.post("/party/create", json=payload, headers=self.headers)
        code = res.json()["code"]

        # User 2 joins via event
        self.client.post(f"/party/{code}/event", json={"type": "CHAT", "text": "Hi"}, headers=self.headers2)
        room_data = self.client.get(f"/party/{code}").json()
        self.assertEqual(len(room_data["members"]), 2)

        # User 2 leaves
        leave_res = self.client.post(f"/party/{code}/leave", headers=self.headers2)
        self.assertEqual(leave_res.status_code, 200)

        room_after = self.client.get(f"/party/{code}").json()
        self.assertEqual(len(room_after["members"]), 1)
        self.assertEqual(room_after["members"][0]["id"], self.account_id)

    def test_guest_unauthenticated_join_and_sync(self):
        # 1. Host creates a party room
        payload = {
            "media": {
                "slug": "guest-test",
                "tmdbId": 333,
                "type": "movie",
                "titleName": "Guest Test Movie",
            },
            "initialTime": 10.0,
        }
        res = self.client.post("/party/create", json=payload, headers=self.headers)
        self.assertEqual(res.status_code, 200)
        code = res.json()["code"]

        # 2. Guest connects via HTTP poll without ANY auth header or cookie!
        poll_res = self.client.get(
            f"/party/{code}/poll?since=0&guest_id=guest-tab-1&guest_name=OspiteTest&guest_color=%2310b981"
        )
        self.assertEqual(poll_res.status_code, 200)
        poll_data = poll_res.json()
        self.assertTrue(poll_data["ok"])
        self.assertIn("yourAccountId", poll_data)
        guest_account_id = poll_data["yourAccountId"]
        # Member should be registered with guest name
        guest_member = next((m for m in poll_data["room"]["members"] if m["id"] == guest_account_id), None)
        self.assertIsNotNone(guest_member)
        self.assertEqual(guest_member["name"], "OspiteTest")

        # 3. Guest posts an event via HTTP without auth header
        event_res = self.client.post(
            f"/party/{code}/event?guest_id=guest-tab-1&guest_name=OspiteTest",
            json={"event": {"type": "PAUSE", "time": 15.0}},
        )
        self.assertEqual(event_res.status_code, 200)
        self.assertFalse(event_res.json()["room"]["state"]["isPlaying"])
        self.assertEqual(event_res.json()["room"]["state"]["time"], 15.0)

        # 4. Guest connects via WebSocket with guest_id and guest_name without token
        with self.client.websocket_connect(
            f"/ws/party/{code}?guest_id=guest-ws-1&guest_name=OspiteWs&guest_color=%23ef4444"
        ) as ws_guest:
            init_msg = ws_guest.receive_json()
            self.assertEqual(init_msg["type"], "ROOM_STATE")
            self.assertIn("yourAccountId", init_msg)


if __name__ == "__main__":
    unittest.main()

