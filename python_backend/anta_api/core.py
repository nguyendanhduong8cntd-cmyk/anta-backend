from __future__ import annotations

import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator

import jwt
from fastapi import Depends, FastAPI, Header, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool


logger = logging.getLogger("anta_api")


class ApiError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def require(condition: Any, code: str, message: str, status: int = 409) -> None:
    if not condition:
        raise ApiError(code, message, status)


def envelope(request: Request, data: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"data": jsonable_encoder(data), "meta": {"requestId": request.state.request_id}, "error": None},
    )


def register_http(app: FastAPI) -> None:
    @app.middleware("http")
    async def request_context(request: Request, call_next):
        incoming = request.headers.get("x-request-id", "")
        request.state.request_id = incoming if re.fullmatch(r"[A-Za-z0-9_-]{8,80}", incoming) else str(uuid.uuid4())
        started = time.monotonic()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
        finally:
            route = request.scope.get("route")
            logger.info(json.dumps({"event": "http.request", "requestId": request.state.request_id,
                "method": request.method, "route": getattr(route, "path", "unmatched"),
                "status": status, "latencyMs": round((time.monotonic() - started) * 1000)}))
        response.headers["X-Request-Id"] = request.state.request_id
        return response

    @app.exception_handler(ApiError)
    async def api_error(request: Request, error: ApiError):
        return JSONResponse(status_code=error.status, content={"data": None,
            "meta": {"requestId": request.state.request_id}, "error": {"code": error.code, "message": error.message}})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, _error: RequestValidationError):
        return JSONResponse(status_code=400, content={"data": None,
            "meta": {"requestId": request.state.request_id},
            "error": {"code": "VALIDATION_FAILED", "message": "Invalid request"}})


async def connection(request: Request) -> AsyncIterator[AsyncConnection]:
    pool: AsyncConnectionPool = request.app.state.pool
    async with pool.connection() as conn:
        yield conn


@dataclass(frozen=True)
class Principal:
    user_id: uuid.UUID
    session_id: uuid.UUID


async def principal(request: Request, authorization: str | None = Header(default=None),
                    conn: AsyncConnection = Depends(connection)) -> Principal:
    if not authorization or not authorization.startswith("Bearer "):
        raise ApiError("UNAUTHORIZED", "Authentication required", 401)
    try:
        claims = jwt.decode(authorization[7:], request.app.state.settings.jwt_secret,
            algorithms=["HS256"], issuer="anta", audience="anta-android",
            options={"require": ["exp", "iat", "iss", "aud", "sub"]})
        user_id, session_id = uuid.UUID(claims["sub"]), uuid.UUID(claims["sid"])
    except (jwt.PyJWTError, ValueError, KeyError, TypeError):
        raise ApiError("UNAUTHORIZED", "Invalid or expired access token", 401) from None
    cur = await conn.execute("""SELECT 1 FROM identity.refresh_sessions s JOIN identity.users u ON u.id=s.user_id
        WHERE s.id=%s AND s.user_id=%s AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='ACTIVE'""",
        (session_id, user_id))
    if not await cur.fetchone():
        raise ApiError("UNAUTHORIZED", "Session has been revoked", 401)
    return Principal(user_id, session_id)


async def require_owner(conn: AsyncConnection, user_id: uuid.UUID, branch_id: uuid.UUID) -> None:
    cur = await conn.execute("""SELECT 1 FROM identity.roles WHERE user_id=%s AND
        (role='admin' OR (branch_id=%s AND role='branch_owner')) LIMIT 1""", (user_id, branch_id))
    require(await cur.fetchone(), "FORBIDDEN", "Branch owner permission required", 403)


async def audit(conn: AsyncConnection, actor: uuid.UUID, action: str, target: uuid.UUID,
                request_id: str, details: dict[str, Any]) -> None:
    await conn.execute("""INSERT INTO platform.audit_events(actor_id,action,target_type,target_id,request_id,details)
        VALUES(%s,%s,'media',%s,%s,%s::jsonb)""",
        (actor, action, str(target), request_id, json.dumps(details)))
