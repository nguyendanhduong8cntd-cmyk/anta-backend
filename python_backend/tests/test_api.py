from pathlib import Path

from dotenv import load_dotenv
from fastapi.testclient import TestClient

from alobo_api.main import app


load_dotenv(Path(__file__).resolve().parents[2] / ".env")


def everything_listed(client: TestClient) -> int:
    return client.get("/api/v1/public/branches", params={"pageSize": 1}).json()["data"]["total"]


def test_readiness_and_public_catalog_against_local_services():
    with TestClient(app) as client:
        ready = client.get("/api/v1/health/ready")
        assert ready.status_code == 200
        assert ready.json()["data"]["status"] == "ready"
        assert ready.headers["x-request-id"]

        sports = client.get("/api/v1/public/sports")
        assert sports.status_code == 200
        assert isinstance(sports.json()["data"], list)
        assert all(isinstance(sport["venue_count"], int) for sport in sports.json()["data"])

        branches = client.get("/api/v1/public/branches", params={"pageSize": 5})
        assert branches.status_code == 200
        assert branches.json()["data"]["pageSize"] == 5
        if branches.json()["data"]["items"]:
            listed = branches.json()["data"]["items"][0]
            branch_id = listed["id"]
            assert {"rating", "review_count", "min_price"} <= listed.keys()
            assert all({"slug", "name"} == sport.keys() for sport in listed["sports"])
            detail = client.get(f"/api/v1/public/branches/{branch_id}")
            assert detail.status_code == 200
            assert isinstance(detail.json()["data"]["yards"], list)
            assert detail.json()["data"]["sports"] == listed["sports"]
            for sort in ("distance", "rating", "price"):
                ordered = client.get("/api/v1/public/branches", params={"sort": sort, "pageSize": 100})
                assert ordered.status_code == 200
                assert ordered.json()["data"]["total"] == branches.json()["data"]["total"]
            best = client.get("/api/v1/public/branches", params={"sort": "rating", "pageSize": 100})
            ratings = [item["rating"] for item in best.json()["data"]["items"] if item["rating"] is not None]
            assert ratings == sorted(ratings, reverse=True)
            unaccented = client.get("/api/v1/public/branches", params={"q": "CAU LONG", "pageSize": 100})
            accented = client.get("/api/v1/public/branches", params={"q": "cầu lông", "pageSize": 100})
            assert unaccented.json()["data"]["total"] == accented.json()["data"]["total"]
            assert client.get(f"/api/v1/public/branches/{branch_id}/services").status_code == 200
            nearby = client.get("/api/v1/public/branches", params={
                "lat": detail.json()["data"]["lat"], "lng": detail.json()["data"]["lng"],
                "radius": 100, "q": detail.json()["data"]["name"]})
            assert nearby.status_code == 200
            assert branch_id in [item["id"] for item in nearby.json()["data"]["items"]]

        invalid = client.get("/api/v1/public/branches", params={"lat": 10})
        assert invalid.status_code == 400
        assert invalid.json()["error"]["code"] == "VALIDATION_FAILED"
        assert client.get("/api/v1/public/branches", params={"sort": "newest"}).status_code == 400
        assert client.get("/api/v1/public/branches", params={"radius": 500}).status_code == 400
        far = {"lat": 37.42, "lng": -122.08, "pageSize": 1}
        assert client.get("/api/v1/public/branches", params={**far, "radius": 20_100_000}).json()["data"]["total"] == everything_listed(client)
        assert client.get("/api/v1/public/branches", params={**far, "radius": 20_100_001}).status_code == 400
        # LIKE's wildcards are ordinary characters when typed: "%" does not match every venue.
        everything = client.get("/api/v1/public/branches", params={"pageSize": 1}).json()["data"]["total"]
        wildcard = client.get("/api/v1/public/branches", params={"q": "%", "pageSize": 1}).json()["data"]["total"]
        assert wildcard == 0 or wildcard < everything

        content = client.get("/api/v1/public/config")
        assert content.status_code == 200
        assert content.json()["data"]["features"]["booking"] is False
        assert client.get("/api/v1/public/content/terms").status_code == 200

        protected = client.get("/api/v1/users/me/favorites")
        assert protected.status_code == 401
