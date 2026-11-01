# The Linck API image. App Platform builds it from the repository root
# (.do/app.yaml), and so does a local build:
#
#   docker build -f apps/api/Dockerfile .
#
# It holds no secrets. Every LINCK_* value arrives from the environment at run
# time, and the root .dockerignore keeps .env files out of the build context.

# ---------------------------------------------------------------- build stage
FROM python:3.12-slim AS build

# uv, pinned, from PyPI: the build already needs Docker Hub and PyPI, and this
# keeps it to those two.
RUN pip install --no-cache-dir --disable-pip-version-check --root-user-action=ignore uv==0.11.32

# Bytecode compiled now, because the runtime cannot write it; files copied
# rather than linked, because uv's cache stays behind in this stage; and only
# the image's own Python, never one uv downloads.
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app
COPY apps/api/pyproject.toml apps/api/uv.lock ./
# --frozen: exactly uv.lock, or fail. --no-dev: no pytest or ruff in production.
# --no-install-project: the app runs from /app as source, so nothing is built
# and nothing outside the lock is fetched.
RUN uv sync --frozen --no-dev --no-install-project

# -------------------------------------------------------------- runtime stage
FROM python:3.12-slim

RUN groupadd --system --gid 10001 linck \
    && useradd --system --uid 10001 --gid linck --no-create-home --home-dir /nonexistent \
        --shell /usr/sbin/nologin linck

WORKDIR /app
# Owned by root and only readable by the process: the API writes nothing to
# its own disk (uploads go to the bucket; see app/core/storage.py).
COPY --from=build /app/.venv /app/.venv
COPY apps/api/alembic.ini ./
COPY apps/api/alembic ./alembic
COPY apps/api/app ./app
COPY apps/api/scripts/bootstrap_roles.py ./scripts/

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER 10001:10001
EXPOSE 8080

# Requests arrive through Vercel's /api rewrite and App Platform's load
# balancer, which has no fixed address, so forwarded headers are trusted from
# any peer. The client address they carry is only recorded on a session row,
# never used to decide anything. The pre-deploy job runs `alembic upgrade
# head` in place of this command.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips=*"]
