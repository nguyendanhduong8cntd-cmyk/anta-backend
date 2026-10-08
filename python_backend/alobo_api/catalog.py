from __future__ import annotations

import re
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from psycopg import AsyncConnection

from .core import Principal, connection, envelope, principal, require
from .media import court_images


router = APIRouter(prefix="/api/v1", tags=["catalog"])

BranchSort = Literal["distance", "rating", "price"]
# Half the Earth's circumference: "nearest first" must list something wherever the user is.
MAX_RADIUS_METERS = 20_100_000
ORDER: dict[str, str] = {
    "distance": "distance_meters NULLS LAST,b.name,b.id",
    "rating": "b.rating DESC NULLS LAST,b.review_count DESC,distance_meters NULLS LAST,b.id",
    "price": "min_price NULLS LAST,distance_meters NULLS LAST,b.id",
}
# What a venue card shows: every list of venues returns these columns.
CARD = """b.id,b.name,b.address,b.timezone,b.opening_hour,b.closing_hour,b.images,b.rating,b.review_count,
    ST_Y(b.location::geometry) AS lat,ST_X(b.location::geometry) AS lng"""
MAX_FAVORITES_LISTED = 200
MIN_PRICE = "(SELECT min(y.hourly_price) FROM catalog.yards y WHERE y.branch_id=b.id AND y.active) AS min_price"
# Under a sport filter: the cheapest hour of that sport, when the venue has a yard for it.
MIN_PRICE_FOR_SPORT = """(SELECT COALESCE(min(y.hourly_price) FILTER (WHERE y.sport_id=%s::uuid),min(y.hourly_price))
    FROM catalog.yards y WHERE y.branch_id=b.id AND y.active) AS min_price"""


def offers(sport: str) -> str:
    """A venue (alias `b`) offers a sport when a yard of it is for that sport or the venue advertises it."""
    return f"""(EXISTS(SELECT 1 FROM catalog.yards y WHERE y.branch_id=b.id AND y.sport_id={sport} AND y.active)
        OR EXISTS(SELECT 1 FROM catalog.branch_sports a WHERE a.branch_id=b.id AND a.sport_id={sport}))"""


def matches(column: str) -> str:
    """Vietnamese is typed with or without its accents: "cau long" must find "Cầu lông"."""
    return f"unaccent({column}) ILIKE '%%' || unaccent(%s) || '%%'"


def literal(term: str | None) -> str | None:
    """What the user typed, with LIKE's own wildcards taken literally."""
    return None if term is None else re.sub(r"([\\%_])", r"\\\1", term)


SPORTS_OF_BRANCH = f"""COALESCE((SELECT json_agg(json_build_object('slug',s.slug,'name',s.name) ORDER BY s.name)
    FROM catalog.sports s WHERE {offers('s.id')}),'[]'::json) AS sports"""


@router.get("/public/sports")
async def sports(request: Request, conn: AsyncConnection = Depends(connection)):
    cur = await conn.execute(f"""SELECT s.id,s.name,s.slug,
        (SELECT count(*)::int FROM catalog.branches b WHERE {offers('s.id')}) AS venue_count
        FROM catalog.sports s ORDER BY s.name""")
    return envelope(request, await cur.fetchall())


@router.get("/public/branches")
async def branches(request: Request, lat: Annotated[float | None, Query(ge=-90, le=90)] = None,
                   lng: Annotated[float | None, Query(ge=-180, le=180)] = None,
                   radius: Annotated[int | None, Query(ge=100, le=MAX_RADIUS_METERS)] = None,
                   sport_id: Annotated[uuid.UUID | None, Query(alias="sportId")] = None,
                   q: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
                   sort: BranchSort = "distance",
                   page: Annotated[int, Query(ge=1, le=10000)] = 1,
                   page_size: Annotated[int, Query(alias="pageSize", ge=1, le=100)] = 20,
                   conn: AsyncConnection = Depends(connection)):
    require((lat is None) == (lng is None), "VALIDATION_FAILED", "lat and lng must be supplied together", 400)
    require(radius is None or lat is not None, "VALIDATION_FAILED", "radius requires coordinates", 400)
    term = literal(q)
    point = "ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography"
    cur = await conn.execute(f"""SELECT {CARD},
        CASE WHEN %s::float8 IS NULL THEN NULL ELSE round(ST_Distance(b.location,{point})) END AS distance_meters,
        {MIN_PRICE_FOR_SPORT},{SPORTS_OF_BRANCH},count(*) OVER()::int AS total FROM catalog.branches b
        WHERE (%s::float8 IS NULL OR ST_DWithin(b.location,{point},%s))
        AND (%s::uuid IS NULL OR {offers('%s')})
        AND (%s::text IS NULL OR {matches('b.name')} OR {matches('b.address')}
          OR EXISTS(SELECT 1 FROM catalog.sports s WHERE {matches('s.name')} AND {offers('s.id')}))
        ORDER BY {ORDER[sort]} LIMIT %s OFFSET %s""",
        (lat, lng, lat, sport_id, lat, lng, lat, radius or 10000, sport_id, sport_id, sport_id, term, term, term, term,
         page_size, (page - 1) * page_size))
    rows = await cur.fetchall()
    photos = await court_images(conn, request, [row["id"] for row in rows])
    items = []
    for row in rows:
        item = {key: value for key, value in row.items() if key != "total"}
        item["images"] = list(row["images"] or []) + [p["url"] for p in photos
            if p["branch_id"] == row["id"] and p["yard_id"] is None]
        items.append(item)
    return envelope(request, {"items": items, "page": page, "pageSize": page_size,
        "total": rows[0]["total"] if rows else 0})


@router.get("/public/branches/{branch_id}")
async def branch(request: Request, branch_id: uuid.UUID, conn: AsyncConnection = Depends(connection)):
    cur = await conn.execute(f"""SELECT b.id,b.shop_id,b.name,b.address,b.description,b.timezone,b.opening_hour,
        b.closing_hour,b.images,b.rules,b.rating,b.review_count,ST_Y(b.location::geometry) AS lat,
        ST_X(b.location::geometry) AS lng,{MIN_PRICE},{SPORTS_OF_BRANCH}
        FROM catalog.branches b WHERE b.id=%s""", (branch_id,))
    item = await cur.fetchone()
    require(item, "NOT_FOUND", "Branch not found", 404)
    cur = await conn.execute("""SELECT id,sport_id,name,hourly_price,currency FROM catalog.yards
        WHERE branch_id=%s AND active ORDER BY name""", (branch_id,))
    yards = await cur.fetchall()
    photos = await court_images(conn, request, [branch_id])
    item["images"] = list(item["images"] or []) + [p["url"] for p in photos if p["yard_id"] is None]
    item["yards"] = [{**yard, "images": [p["url"] for p in photos if p["yard_id"] == yard["id"]]}
        for yard in yards]
    return envelope(request, item)


@router.get("/public/branches/{branch_id}/services")
async def services(request: Request, branch_id: uuid.UUID, conn: AsyncConnection = Depends(connection)):
    cur = await conn.execute("SELECT 1 FROM catalog.branches WHERE id=%s", (branch_id,))
    require(await cur.fetchone(), "NOT_FOUND", "Branch not found", 404)
    cur = await conn.execute("SELECT * FROM catalog.services WHERE branch_id=%s ORDER BY name", (branch_id,))
    return envelope(request, await cur.fetchall())


@router.get("/users/me/favorites")
async def favorites(request: Request, user: Principal = Depends(principal),
                    conn: AsyncConnection = Depends(connection)):
    # The latest addition first, each venue as it appears in any other list of venues.
    cur = await conn.execute(f"""SELECT {CARD},{MIN_PRICE},{SPORTS_OF_BRANCH} FROM catalog.favorites f
        JOIN catalog.branches b ON b.id=f.branch_id WHERE f.user_id=%s ORDER BY f.created_at DESC,b.id LIMIT %s""",
        (user.user_id, MAX_FAVORITES_LISTED))
    rows = await cur.fetchall()
    photos = await court_images(conn, request, [row["id"] for row in rows])
    for row in rows:
        row["images"] = list(row["images"] or []) + [p["url"] for p in photos
            if p["branch_id"] == row["id"] and p["yard_id"] is None]
    return envelope(request, rows)


async def set_favorite(request: Request, branch_id: uuid.UUID, user: Principal,
                       conn: AsyncConnection, add: bool):
    cur = await conn.execute("SELECT 1 FROM catalog.branches WHERE id=%s", (branch_id,))
    require(await cur.fetchone(), "NOT_FOUND", "Branch not found", 404)
    if add:
        await conn.execute("""INSERT INTO catalog.favorites(user_id,branch_id) VALUES(%s,%s)
            ON CONFLICT DO NOTHING""", (user.user_id, branch_id))
    else:
        await conn.execute("DELETE FROM catalog.favorites WHERE user_id=%s AND branch_id=%s",
            (user.user_id, branch_id))
    return envelope(request, {"favorite": add}, 201 if add else 200)


@router.post("/users/me/favorites/{branch_id}")
async def favorite_add(request: Request, branch_id: uuid.UUID, user: Principal = Depends(principal),
                       conn: AsyncConnection = Depends(connection)):
    return await set_favorite(request, branch_id, user, conn, True)


@router.delete("/users/me/favorites/{branch_id}")
async def favorite_remove(request: Request, branch_id: uuid.UUID, user: Principal = Depends(principal),
                          conn: AsyncConnection = Depends(connection)):
    return await set_favorite(request, branch_id, user, conn, False)
