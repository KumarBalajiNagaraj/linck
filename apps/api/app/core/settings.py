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

    # WhatsApp Business Cloud API. Drivers send the bunk slip's photo to the
    # fleet's WhatsApp Business number; Meta posts it to /webhooks/whatsapp.
    # The number belongs to one tenant, named here, because the webhook is
    # called by Meta with no session and RLS needs a tenant to write under.
    # Empty values leave the webhook answering 503 rather than half-working.
    whatsapp_verify_token: str = ""
    whatsapp_app_secret: str = ""
    whatsapp_access_token: str = ""
    whatsapp_phone_number_id: str = ""
    whatsapp_organization_id: str = ""
    whatsapp_graph_url: str = "https://graph.facebook.com/v21.0"
    whatsapp_react_on_receipt: bool = True

    # Uploaded files: bill scans and the slip photos drivers send on WhatsApp.
    # One object per tenant per SHA-256 of its bytes, `<org id>/<sha256>`;
    # core.files and core.whatsapp_messages hold what makes each one reachable.
    # Ten megabytes covers a phone photo or a multi-page scan.
    #
    # `local` keeps them under file_storage_dir, for development. `s3` keeps
    # them in a private S3-compatible bucket: DigitalOcean Spaces in production,
    # because App Platform's disk is wiped on every deploy. The API refuses to
    # start with `local` anywhere but local development (app/core/storage.py).
    file_store: Literal["local", "s3"] = "local"
    file_storage_dir: str = "var/files"
    file_max_bytes: int = 10 * 1024 * 1024
    # Empty endpoint means AWS S3 itself; Spaces is https://<region>.digitaloceanspaces.com.
    s3_endpoint_url: str = ""
    s3_region: str = ""
    s3_bucket: str = ""
    s3_access_key_id: str = ""
    s3_secret_access_key: str = ""

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
