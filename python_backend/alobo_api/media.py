from __future__ import annotations

import asyncio
import uuid

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Request
from psycopg import AsyncConnection
from pydantic import BaseModel, ConfigDict, Field

from .core import ApiError, Principal, audit, connection, envelope, principal, require, require_owner
from .storage import ALLOWED_MIME, MAX_UPLOAD_BYTES, R2Storage, sanitize_court_image


router = APIRouter(prefix="/api/v1/branches/{branch_id}/images", tags=["court-images"])


class CourtPresign(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    mime_type: str = Field(alias="mimeType")
    size: int = Field(ge=1, le=MAX_UPLOAD_BYTES)
    yard_id: uuid.UUID | None = Field(default=None, alias="yardId")


def storage(request: Request) -> R2Storage:
    cached = getattr(request.app.state, "r2", None)
    if cached is None:
        cached = R2Storage(request.app.state.settings)
        request.app.state.r2 = cached
    return cached


async def court_images(conn: AsyncConnection, request: Request, branch_ids: list[uuid.UUID]) -> list[dict]:
    if not branch_ids:
        return []
    cur = await conn.execute("""SELECT id,branch_id,yard_id,object_key,width,height FROM media.uploads
        WHERE purpose='COURT' AND status='CLEAN' AND archived_at IS NULL AND branch_id=ANY(%s::uuid[])
        ORDER BY created_at,id""", (branch_ids,))
    rows = await cur.fetchall()
    if not rows:
        return []
    r2 = storage(request)
    return [{"id": row["id"], "branch_id": row["branch_id"], "yard_id": row["yard_id"],
        "url": r2.presign_get(row["object_key"]), "width": row["width"], "height": row["height"]} for row in rows]


@router.post("/presign")
async def presign(request: Request, branch_id: uuid.UUID, body: CourtPresign,
                  user: Principal = Depends(principal), conn: AsyncConnection = Depends(connection)):
    await require_owner(conn, user.user_id, branch_id)
    require(body.mime_type in ALLOWED_MIME, "VALIDATION_FAILED", "Unsupported image MIME type", 400)
    branch = await conn.execute("SELECT 1 FROM catalog.branches WHERE id=%s", (branch_id,))
    require(await branch.fetchone(), "NOT_FOUND", "Branch not found", 404)
    if body.yard_id:
        yard = await conn.execute("SELECT 1 FROM catalog.yards WHERE id=%s AND branch_id=%s",
            (body.yard_id, branch_id))
        require(await yard.fetchone(), "NOT_FOUND", "Yard does not belong to branch", 404)
    r2 = storage(request)
    rate_key = f"{request.app.state.settings.redis_key_prefix}media:presign:{user.user_id}"
    async with request.app.state.redis.pipeline(transaction=True) as pipe:
        pipe.incr(rate_key)
        pipe.expire(rate_key, 3600, nx=True)
        count, _ = await pipe.execute()
    require(count <= 20, "RATE_LIMITED", "Too many upload requests", 429)
    upload_id = uuid.uuid4()
    key = f"quarantine/courts/{branch_id}/{upload_id}"
    try:
        url = r2.presign_put(key, body.mime_type)
    except (BotoCoreError, ClientError) as error:
        raise ApiError("STORAGE_UNAVAILABLE", "R2 signing is unavailable", 503) from error
    await conn.execute("""INSERT INTO media.uploads(id,user_id,object_key,source_key,mime_type,expected_size,
        purpose,branch_id,yard_id) VALUES(%s,%s,%s,%s,%s,%s,'COURT',%s,%s)""",
        (upload_id, user.user_id, key, key, body.mime_type, body.size, branch_id, body.yard_id))
    await audit(conn, user.user_id, "court_image.presign", upload_id, request.state.request_id,
        {"branchId": str(branch_id), "yardId": str(body.yard_id) if body.yard_id else None})
    return envelope(request, {"uploadId": upload_id, "method": "PUT", "url": url,
        "headers": {"Content-Type": body.mime_type}, "expiresIn": 120, "status": "PENDING",
        "note": "PUT raw bytes, then call complete; URLs are never stored in the catalog"}, 201)


@router.post("/{upload_id}/complete")
async def complete(request: Request, branch_id: uuid.UUID, upload_id: uuid.UUID,
                   user: Principal = Depends(principal), conn: AsyncConnection = Depends(connection)):
    await require_owner(conn, user.user_id, branch_id)
    cur = await conn.execute("""SELECT * FROM media.uploads WHERE id=%s AND user_id=%s AND branch_id=%s
        AND purpose='COURT' AND archived_at IS NULL""", (upload_id, user.user_id, branch_id))
    row = await cur.fetchone()
    require(row, "NOT_FOUND", "Court image upload not found", 404)
    if row["status"] == "CLEAN":
        return envelope(request, {"uploadId": upload_id, "status": "CLEAN",
            "width": row["width"], "height": row["height"]}, 201)
    require(row["status"] == "PENDING", "UPLOAD_REJECTED", "Upload is not available")
    r2 = storage(request)
    source = row["source_key"] or row["object_key"]
    try:
        metadata = await asyncio.to_thread(r2.head, source)
    except (BotoCoreError, ClientError) as error:
        raise ApiError("UPLOAD_NOT_FOUND", "Object is not available in R2", 409) from error
    if metadata.get("ContentLength") != row["expected_size"] or metadata.get("ContentType") != row["mime_type"]:
        await conn.execute("""UPDATE media.uploads SET status='REJECTED',completed_at=now()
            WHERE id=%s AND status='PENDING'""", (upload_id,))
        return envelope(request, {"uploadId": upload_id, "status": "REJECTED"}, 201)
    try:
        raw = await asyncio.to_thread(r2.read_bounded, source, row["expected_size"])
    except (BotoCoreError, ClientError) as error:
        raise ApiError("STORAGE_UNAVAILABLE", "Unable to read uploaded image", 503) from error
    require(len(raw) == row["expected_size"], "UPLOAD_SIZE_MISMATCH", "Uploaded file size changed", 409)
    clean_body, width, height = await asyncio.to_thread(sanitize_court_image, raw)
    clean_key = f"courts/{branch_id}/{upload_id}.webp"
    try:
        await asyncio.to_thread(r2.put_clean, clean_key, clean_body)
    except (BotoCoreError, ClientError) as error:
        raise ApiError("STORAGE_UNAVAILABLE", "Unable to publish sanitized image", 503) from error
    cur = await conn.execute("""UPDATE media.uploads SET status='CLEAN',object_key=%s,mime_type='image/webp',
        expected_size=%s,width=%s,height=%s,completed_at=now() WHERE id=%s AND status='PENDING'
        RETURNING id""", (clean_key, len(clean_body), width, height, upload_id))
    if not await cur.fetchone():
        current = await conn.execute("SELECT status,width,height FROM media.uploads WHERE id=%s", (upload_id,))
        latest = await current.fetchone()
        require(latest and latest["status"] == "CLEAN", "UPLOAD_REJECTED", "Upload was rejected while processing")
        width, height = latest["width"], latest["height"]
    await audit(conn, user.user_id, "court_image.published", upload_id, request.state.request_id,
        {"branchId": str(branch_id)})
    return envelope(request, {"uploadId": upload_id, "status": "CLEAN", "width": width, "height": height}, 201)


@router.delete("/{upload_id}")
async def archive(request: Request, branch_id: uuid.UUID, upload_id: uuid.UUID,
                  user: Principal = Depends(principal), conn: AsyncConnection = Depends(connection)):
    await require_owner(conn, user.user_id, branch_id)
    cur = await conn.execute("""UPDATE media.uploads SET archived_at=coalesce(archived_at,now())
        WHERE id=%s AND branch_id=%s AND purpose='COURT' RETURNING id""", (upload_id, branch_id))
    require(await cur.fetchone(), "NOT_FOUND", "Court image not found", 404)
    await audit(conn, user.user_id, "court_image.archive", upload_id, request.state.request_id,
        {"branchId": str(branch_id)})
    return envelope(request, {"archived": True})
