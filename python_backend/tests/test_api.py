from pathlib import Path

from dotenv import load_dotenv
from fastapi.testclient import TestClient

from alobo_api.main import app


load_dotenv(Path(__file__).resolve().parents[2] / ".env")


def test_readiness_and_public_catalog_against_local_services():
    with TestClient(app) as client:
        ready = client.get("/api/v1/health/ready")
        assert ready.status_code == 200
        assert ready.json()["data"]["status"] == "ready"
        assert ready.headers["x-request-id"]

        sports = client.get("/api/v1/public/sports")
        assert sports.status_code == 200
        assert isinstance(sports.json()["data"], list)

        branches = client.get("/api/v1/public/branches", params={"pageSize": 5})
        assert branches.status_code == 200
        assert branches.json()["data"]["pageSize"] == 5
        if branches.json()["data"]["items"]:
            branch_id = branches.json()["data"]["items"][0]["id"]
            detail = client.get(f"/api/v1/public/branches/{branch_id}")
            assert detail.status_code == 200
            assert isinstance(detail.json()["data"]["yards"], list)
            assert client.get(f"/api/v1/public/branches/{branch_id}/services").status_code == 200
            nearby = client.get("/api/v1/public/branches", params={
                "lat": detail.json()["data"]["lat"], "lng": detail.json()["data"]["lng"],
                "radius": 100, "q": detail.json()["data"]["name"]})
            assert nearby.status_code == 200
            assert branch_id in [item["id"] for item in nearby.json()["data"]["items"]]

        invalid = client.get("/api/v1/public/branches", params={"lat": 10})
        assert invalid.status_code == 400
        assert invalid.json()["error"]["code"] == "VALIDATION_FAILED"

        content = client.get("/api/v1/public/config")
        assert content.status_code == 200
        assert content.json()["data"]["features"]["booking"] is False
        assert client.get("/api/v1/public/content/terms").status_code == 200

        protected = client.get("/api/v1/users/me/favorites")
        assert protected.status_code == 401
