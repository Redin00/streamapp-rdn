import asyncio
import json
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

    def test_websocket_unauthenticated_rejected(self):
        # Connecting without token or with invalid token returns ERROR message
        with self.client.websocket_connect("/ws/party/ROOM-123?token=invalid_token") as ws:
            msg = ws.receive_json()
            self.assertEqual(msg.get("type"), "ERROR")
            self.assertIn("Authentication", msg.get("message", ""))


if __name__ == "__main__":
    unittest.main()
