from functools import lru_cache
from typing import Literal

from pydantic import SecretStr
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
    whatsapp_media_dir: str = "var/whatsapp-media"
    whatsapp_react_on_receipt: bool = True

    # Uploaded files (bill scans). One directory per tenant under this root,
    # one file per SHA-256 of its bytes; core.files holds what makes each one
    # reachable. Ten megabytes covers a phone photo or a multi-page scan.
    file_storage_dir: str = "var/files"
    file_max_bytes: int = 10 * 1024 * 1024

    # The largest request body any route takes but the bill upload and Meta's
    # webhook, which have caps of their own (app/core/limits.py). The screens
    # send small JSON; the largest, a WhatsApp import at its 500-claim limit,
    # comes to about 0.9 MB with every claim's capture record.
    max_body_bytes: int = 1024 * 1024

    # Industry news (LIN-10). Headlines come from Google News RSS, which is
    # free and needs no key: one search per query below (LINCK_NEWS_QUERIES,
    # as a JSON list). The short summaries are written by any OpenAI-compatible
    # chat-completions endpoint, chosen by three values: the base URL (the part
    # before chat/completions), an API key and the model name. The default is
    # Google Gemini's free tier; Google renames its free models now and then,
    # so check its current list. The AI stays off, and nothing is sent to any
    # model, until a key is set: the screen shows the top headlines alone and
    # says so. Gemini first, then the alternatives, in .env.example.
    ai_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai/"
    ai_api_key: SecretStr = SecretStr("")
    ai_model: str = "gemini-2.5-flash"
    # A hosted free model answers within a minute; a local model on a CPU may need several.
    ai_timeout_seconds: int = 60
    news_queries: list[str] = [
        "Tamil Nadu construction",
        "Chennai real estate",
        "Tamil Nadu road OR highway project OR tender",
        '"M-sand" price OR rules Tamil Nadu',
        "cement price Tamil Nadu",
        'Tamil Nadu quarry OR "sand mining" policy OR rules OR ban',
        "northeast monsoon Tamil Nadu",
        'Chennai metro OR airport OR "ring road" project',
    ]

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
