from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from redis.asyncio import Redis
from starlette.exceptions import HTTPException

from . import catalog, identity, media
from .config import Settings
from .core import connection, envelope, register_http


logging.basicConfig(level=logging.INFO, format="%(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings.from_env()
    pool = AsyncConnectionPool(settings.database_url, min_size=1, max_size=20, open=False,
        kwargs={"row_factory": dict_row, "options": "-c statement_timeout=15000"})
    redis = Redis.from_url(settings.redis_url, decode_responses=True)
    app.state.settings, app.state.pool, app.state.redis, app.state.r2 = settings, pool, redis, None
    await pool.open(wait=True)
    try:
        await redis.ping()
        yield
    finally:
        await redis.aclose()
        await pool.close()


def create_app() -> FastAPI:
    app = FastAPI(title="Alobo Clone API — FastAPI port", version="0.1.0",
        docs_url="/docs", openapi_url="/docs-json", lifespan=lifespan)
    register_http(app)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, error: HTTPException):
        code = "NOT_FOUND" if error.status_code == 404 else "INVALID_REQUEST"
        return JSONResponse(status_code=error.status_code, content={"data": None,
            "meta": {"requestId": request.state.request_id},
            "error": {"code": code, "message": "Invalid request"}})

    @app.exception_handler(Exception)
    async def unknown_error(request: Request, error: Exception):
        logging.getLogger("alobo_api").error("Unhandled %s requestId=%s", type(error).__name__,
            request.state.request_id)
        return JSONResponse(status_code=500, content={"data": None,
            "meta": {"requestId": request.state.request_id},
            "error": {"code": "INTERNAL_ERROR", "message": "Internal server error"}})

    @app.get("/api/v1/health/ready", tags=["health"])
    async def ready(request: Request, conn=Depends(connection)):
        await conn.execute("SELECT 1")
        await request.app.state.redis.ping()
        return envelope(request, {"status": "ready", "database": "ok", "redis": "ok"})

    @app.get("/api/v1/public/config", tags=["content"])
    async def config(request: Request):
        # Only implemented Python features are reported enabled in this port.
        return envelope(request, {"minimumAndroidVersionCode": 2603, "latestAndroidVersionCode": 2603,
            "features": {"booking": False, "sandboxPayment": False, "socialLogin": False,
                "membership": False, "paidMembership": False, "academy": False, "paidClasses": False,
                "socialEvents": False, "paidTickets": False, "commerce": False, "chat": False,
                "chatE2E": False, "mediaUpload": False,
                "courtImageUpload": request.app.state.settings.r2_configured},
            "feedbackEmail": "support@your-domain.com"})

    @app.get("/api/v1/public/content/{slug}", tags=["content"])
    async def document(request: Request, slug: str, conn=Depends(connection)):
        from .core import require
        cur = await conn.execute("SELECT * FROM content.documents WHERE slug=%s", (slug,))
        row = await cur.fetchone()
        require(row, "NOT_FOUND", "Document not found", 404)
        return envelope(request, row)

    app.include_router(catalog.router)
    app.include_router(identity.router)
    app.include_router(media.router)
    return app


app = create_app()
