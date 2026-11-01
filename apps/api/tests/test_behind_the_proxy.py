"""What the deployment behind Vercel's /api rewrite relies on (docs/DEPLOY.md).

The browser talks only to the Vercel domain, and Vercel forwards /api/* to
App Platform. The sign-in cookies must therefore be the first-party kind the
browser keeps for that one host: __Host- prefixed, Secure, HttpOnly,
SameSite=Lax, Path=/ and no Domain. The redirect URL Google is given comes
from settings, never from the request, whose Host is the API's own.

Cookie names are fixed when app.core.security is imported, from
LINCK_ENVIRONMENT, so this runs in a fresh interpreter configured as production.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

PROBE = """
import json, uuid
from datetime import UTC, datetime
from fastapi import Response
from app.api import auth, deps
from app.core import security

response = Response()
credential = security.SessionCredential(uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), "token", datetime.now(UTC))
security.set_auth_cookies(response, credential)
security.issue_flow_cookie(response, state="s", code_verifier="v", nonce="n", next_path="/")
print(json.dumps({
    "cookies": [value.decode() for key, value in response.raw_headers if key == b"set-cookie"],
    "read_as": deps.session_cookie_name(),
    "redirect_uri": auth._oauth_client().redirect_uri,
}))
"""

VERCEL = "https://linck.example"


def test_sign_in_is_first_party_on_the_vercel_domain() -> None:
    env = {
        **os.environ,
        "LINCK_ENVIRONMENT": "production",
        "LINCK_SESSION_SECRET": "x" * 48,
        "LINCK_WEB_APP_URL": VERCEL,
        "LINCK_OAUTH_REDIRECT_URL": f"{VERCEL}/api/auth/google/callback",
    }
    ran = subprocess.run(
        [sys.executable, "-c", PROBE],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    probe = json.loads(ran.stdout)

    assert probe["read_as"] == "__Host-linck_session"
    assert [cookie.split("=", 1)[0] for cookie in probe["cookies"]] == [
        "__Host-linck_session",
        "__Host-linck_session_refresh",
        "__Host-linck_session_flow",
    ]
    for cookie in probe["cookies"]:
        attributes = {part.strip().split("=", 1)[0].lower(): part.strip() for part in cookie.split(";")[1:]}
        assert "secure" in attributes and "httponly" in attributes, cookie
        assert attributes["samesite"].lower() == "samesite=lax", cookie
        assert attributes["path"] == "Path=/", cookie
        # A Domain attribute would void __Host- and share the cookie with sibling hosts.
        assert "domain" not in attributes, cookie
    assert probe["redirect_uri"] == f"{VERCEL}/api/auth/google/callback"
