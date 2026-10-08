import time
import uuid
from pathlib import Path

import jwt
import psycopg
from dotenv import load_dotenv
from fastapi.testclient import TestClient

from anta_api.main import app


load_dotenv(Path(__file__).resolve().parents[2] / ".env")


def test_existing_jwt_profile_update_and_logout():
    user_id, session_id = uuid.uuid4(), uuid.uuid4()
    now = int(time.time())
    with TestClient(app) as client:
        settings = app.state.settings
        token = jwt.encode({"sub": str(user_id), "sid": str(session_id),
            "iss": "anta", "aud": "anta-android", "iat": now, "exp": now + 900},
            settings.jwt_secret, algorithm="HS256")
        headers = {"Authorization": f"Bearer {token}"}
        with psycopg.connect(settings.database_url, autocommit=True) as db:
            db.execute("""INSERT INTO identity.users(id,identifier,display_name,password_hash)
                VALUES(%s,%s,%s,%s)""", (user_id, f"fastapi-{user_id}@example.invalid", "Test", "unused"))
            db.execute("""INSERT INTO identity.refresh_sessions(id,user_id,family_id,refresh_hash,device_id,expires_at)
                VALUES(%s,%s,%s,%s,%s,now()+interval '1 hour')""",
                (session_id, user_id, uuid.uuid4(), uuid.uuid4().hex, "test-device"))
            try:
                profile = client.get("/api/v1/users/me", headers=headers)
                assert profile.status_code == 200
                assert profile.json()["data"]["displayName"] == "Test"
                assert profile.json()["data"]["passwordLogin"] is True

                updated = client.patch("/api/v1/users/me", headers=headers,
                    json={"displayName": "  New name  "})
                assert updated.status_code == 200
                assert updated.json()["data"]["displayName"] == "New name"
                assert updated.json()["data"]["version"] == 2

                invalid = client.patch("/api/v1/users/me", headers=headers, json={"displayName": "   "})
                assert invalid.status_code == 400

                # A favourite is listed as the venue card the public list shows, minus the distance.
                listed = client.get("/api/v1/public/branches", params={"pageSize": 1}).json()["data"]["items"]
                assert client.get("/api/v1/users/me/favorites", headers=headers).json()["data"] == []
                if listed:
                    card = {key: value for key, value in listed[0].items() if key != "distance_meters"}
                    assert client.post(f"/api/v1/users/me/favorites/{card['id']}", headers=headers).status_code == 201
                    assert client.get("/api/v1/users/me/favorites", headers=headers).json()["data"] == [card]
                    assert client.delete(f"/api/v1/users/me/favorites/{card['id']}", headers=headers).status_code == 200
                    assert client.get("/api/v1/users/me/favorites", headers=headers).json()["data"] == []

                logout = client.post("/api/v1/auth/logout", headers=headers)
                assert logout.status_code == 200
                assert logout.json()["data"]["loggedOut"] is True
                assert client.get("/api/v1/users/me", headers=headers).status_code == 401
            finally:
                db.execute("DELETE FROM catalog.favorites WHERE user_id=%s", (user_id,))
                db.execute("DELETE FROM identity.refresh_sessions WHERE id=%s", (session_id,))
                db.execute("DELETE FROM identity.users WHERE id=%s", (user_id,))
