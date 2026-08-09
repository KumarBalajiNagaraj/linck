from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="LINCK_", extra="ignore")

    environment: Literal["local", "staging", "production"] = "local"

    # The application connects as a role that owns nothing and has no BYPASSRLS.
    # Migrations run as a separate, more privileged role. If these are ever the
    # same role in a deployed environment, every RLS policy silently evaporates
    # — see check_rls_posture() in app/core/db.py, which refuses to start.
    database_url: str = "postgresql+asyncpg://localhost/linck_dev"
    migration_database_url: str = "postgresql+psycopg://localhost/linck_dev"

    # Google OAuth 2.0 (Authorization Code + PKCE). The SPA never holds a token;
    # FastAPI sets an httpOnly session cookie and rotates the refresh token.
    google_client_id: str = ""
    google_client_secret: str = ""
    oauth_redirect_url: str = "http://localhost:8000/auth/google/callback"
    web_app_url: str = "http://localhost:5173"

    # Restricts sign-in to these Google Workspace hosted domains when set.
    # Empty means any Google account may attempt sign-in — it still has to match
    # a pre-registered user, so this is defence in depth, not the gate.
    allowed_hosted_domains: list[str] = []

    session_secret: str = "dev-only-not-a-secret-change-me"
    session_cookie_name: str = "__Host-linck_session"
    session_ttl_minutes: int = 60
    refresh_ttl_days: int = 30

    @property
    def cookie_secure(self) -> bool:
        # __Host- prefixed cookies require Secure, which requires HTTPS. Local
        # development over http:// therefore drops the prefix; see auth.py.
        return self.environment != "local"


@lru_cache
def get_settings() -> Settings:
    return Settings()
