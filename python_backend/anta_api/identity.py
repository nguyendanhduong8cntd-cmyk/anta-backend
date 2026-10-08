from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from psycopg import AsyncConnection

from .core import Principal, connection, envelope, principal, require


router = APIRouter(prefix="/api/v1", tags=["identity"])


class ProfileUpdate(BaseModel):
    display_name: str | None = Field(default=None, alias="displayName", min_length=1, max_length=100)


async def profile_row(conn: AsyncConnection, user_id):
    cur = await conn.execute("""SELECT id,identifier,display_name,password_login_enabled,created_at,version
        FROM identity.users WHERE id=%s""", (user_id,))
    row = await cur.fetchone()
    require(row, "NOT_FOUND", "User not found", 404)
    return {"id": row["id"], "identifier": row["identifier"],
        "displayName": row["display_name"], "passwordLogin": row["password_login_enabled"], "createdAt": row["created_at"],
        "version": row["version"]}


@router.get("/users/me")
async def me(request: Request, user: Principal = Depends(principal),
             conn: AsyncConnection = Depends(connection)):
    return envelope(request, await profile_row(conn, user.user_id))


@router.patch("/users/me")
async def update_me(request: Request, body: ProfileUpdate, user: Principal = Depends(principal),
                    conn: AsyncConnection = Depends(connection)):
    if body.display_name is not None:
        name = body.display_name.strip()
        require(name, "VALIDATION_FAILED", "Display name cannot be blank", 400)
        await conn.execute("""UPDATE identity.users SET display_name=%s,updated_at=now(),version=version+1
            WHERE id=%s""", (name, user.user_id))
    return envelope(request, await profile_row(conn, user.user_id))


@router.post("/auth/logout")
async def logout(request: Request, user: Principal = Depends(principal),
                 conn: AsyncConnection = Depends(connection)):
    await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
        (f"identity-user:{user.user_id}",))
    await conn.execute("""UPDATE identity.refresh_sessions SET revoked_at=coalesce(revoked_at,now())
        WHERE id=%s AND user_id=%s""", (user.session_id, user.user_id))
    return envelope(request, {"loggedOut": True})
