"""The FastAPI application.

The startup hook is the part worth reading. `check_rls_posture()` asserts that
row level security is not just enabled but FORCED on every tenant table,
because a table's owner bypasses RLS by default — so if the app ever connects
as the role that owns the tables, every policy silently stops applying and
every query returns every tenant's rows. Nothing errors. The data is just
wrong, for everyone, until someone notices. A process that refuses to start is
the only failure mode loud enough to be worth having.
"""

import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import Response

from app.api.me import router as me_router
from app.api.whatsapp import router as whatsapp_router
from app.api.whatsapp import webhook_router as whatsapp_webhook_router
from app.core.db import check_rls_posture, engine
from app.core.settings import get_settings

log = logging.getLogger("linck.api")

REQUEST_ID_HEADER = "X-Request-Id"

try:
    from app.api.auth import router as auth_router
except ModuleNotFoundError as exc:  # pragma: no cover - the auth router lands separately
    if exc.name != "app.api.auth":
        raise
    auth_router = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    problems = await check_rls_posture()
    for problem in problems:
        log.error("row level security posture: %s", problem)
    if problems:
        raise RuntimeError(
            f"refusing to start: {len(problems)} row-level-security problem(s) — "
            "tenant isolation is not enforceable in this database"
        )

    settings = get_settings()
    if auth_router is None:
        if settings.environment != "local":
            raise RuntimeError("refusing to start: app.api.auth is missing, so nobody can sign in")
        log.warning("app.api.auth not found — starting without sign-in routes (local only)")

    log.info("linck api ready (environment=%s)", settings.environment)
    yield
    await engine.dispose()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Linck API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/docs" if settings.environment != "production" else None,
    )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next) -> Response:  # type: ignore[no-untyped-def]
        # Accepted from the caller when present so a trace survives the hop
        # from the SPA, and minted otherwise. It is echoed back on every
        # response, which is what makes a screenshot of a failure enough to
        # find the request in the log.
        request_id = request.headers.get(REQUEST_ID_HEADER) or str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers[REQUEST_ID_HEADER] = request_id
        return response

    # Credentialed CORS: the session is an httpOnly cookie, so the SPA calls
    # with `credentials: 'include'` and the browser then refuses a wildcard
    # origin. The web origin is therefore named exactly, from settings.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.web_app_url],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", REQUEST_ID_HEADER],
        expose_headers=[REQUEST_ID_HEADER],
    )

    @app.get("/health", tags=["ops"])
    async def health() -> dict[str, str]:
        # Deliberately does not touch the database: this answers "is the
        # process up", and a readiness probe that fails on a slow query
        # restarts a healthy process at the worst possible moment.
        return {"status": "ok", "environment": settings.environment}

    if auth_router is not None:
        app.include_router(auth_router)
    app.include_router(me_router)
    app.include_router(whatsapp_webhook_router)
    app.include_router(whatsapp_router)

    return app


app = create_app()
