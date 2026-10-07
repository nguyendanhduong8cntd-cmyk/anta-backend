from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from psycopg import AsyncConnection

from .core import Principal, connection, envelope, principal, require
from .media import court_images


router = APIRouter(prefix="/api/v1", tags=["catalog"])


@router.get("/public/sports")
async def sports(request: Request, conn: AsyncConnection = Depends(connection)):
    cur = await conn.execute("SELECT id,name,slug FROM catalog.sports ORDER BY name")
    return envelope(request, await cur.fetchall())


@router.get("/public/branches")
async def branches(request: Request, lat: Annotated[float | None, Query(ge=-90, le=90)] = None,
                   lng: Annotated[float | None, Query(ge=-180, le=180)] = None,
                   radius: Annotated[int, Query(ge=100, le=100000)] = 10000,
                   sport_id: Annotated[uuid.UUID | None, Query(alias="sportId")] = None,
                   q: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
                   page: Annotated[int, Query(ge=1, le=10000)] = 1,
                   page_size: Annotated[int, Query(alias="pageSize", ge=1, le=100)] = 20,
                   conn: AsyncConnection = Depends(connection)):
    require((lat is None) == (lng is None), "VALIDATION_FAILED", "lat and lng must be supplied together", 400)
    point = "ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography"
    cur = await conn.execute(f"""SELECT b.id,b.name,b.address,b.timezone,b.images,
        ST_Y(b.location::geometry) AS lat,ST_X(b.location::geometry) AS lng,
        CASE WHEN %s::float8 IS NULL THEN NULL ELSE round(ST_Distance(b.location,{point})) END AS distance_meters,
        count(*) OVER()::int AS total FROM catalog.branches b
        WHERE (%s::float8 IS NULL OR ST_DWithin(b.location,{point},%s))
        AND (%s::uuid IS NULL OR EXISTS(SELECT 1 FROM catalog.yards y WHERE y.branch_id=b.id AND y.sport_id=%s AND y.active))
        AND (%s::text IS NULL OR b.name ILIKE '%%' || %s || '%%' OR b.address ILIKE '%%' || %s || '%%')
        ORDER BY distance_meters NULLS LAST,b.name,b.id LIMIT %s OFFSET %s""",
        (lat, lng, lat, lat, lng, lat, radius, sport_id, sport_id, q, q, q, page_size, (page - 1) * page_size))
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
    cur = await conn.execute("""SELECT id,shop_id,name,address,description,timezone,opening_hour,closing_hour,
        images,rules,ST_Y(location::geometry) AS lat,ST_X(location::geometry) AS lng
        FROM catalog.branches WHERE id=%s""", (branch_id,))
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
    cur = await conn.execute("""SELECT b.id,b.name,b.address,b.images FROM catalog.favorites f
        JOIN catalog.branches b ON b.id=f.branch_id WHERE f.user_id=%s ORDER BY f.created_at DESC""",
        (user.user_id,))
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
