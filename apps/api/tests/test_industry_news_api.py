"""Industry news through the API (LIN-10): who may read it, how often it may be
refreshed, and that one tenant's digest is invisible and untouchable from another.

The refresh's network is replaced through FastAPI's dependency override with
httpx.MockTransport (industry_news_fakes.FakeNet), so nothing here leaves the
machine. Each test makes its own organization, because the refresh limit is
per organization.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from conftest import APP_ROLE, Person, Tenant
from industry_news_fakes import (
    KEY,
    METRO,
    MODEL,
    MODEL_URL,
    MSAND,
    QUERIES,
    TENDERS,
    FakeNet,
    article,
    line,
    model_reply,
    two_feeds,
)
from pydantic import SecretStr
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from app.api.insights import http_transport
from app.core.db import tenant_session
from app.core.settings import get_settings
from app.main import app
from app.models.ai import IndustryDigest
from app.services.industry_digest import PROMPT_VERSION

READ = "executive.dashboard.read"
REFRESH = "/insights/industry/refresh"


@pytest.fixture
def net(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeNet]:
    """The two test feeds, dated from now, and no model: the AI is off until a test turns it on."""
    fake = FakeNet(feeds=two_feeds(datetime.now(UTC)))
    settings = get_settings()
    monkeypatch.setattr(settings, "news_queries", QUERIES)
    monkeypatch.setattr(settings, "ai_api_key", SecretStr(""))
    app.dependency_overrides[http_transport] = fake.transport
    yield fake
    app.dependency_overrides.pop(http_transport, None)


@pytest.fixture
def with_model(monkeypatch: pytest.MonkeyPatch, net: FakeNet) -> FakeNet:
    settings = get_settings()
    monkeypatch.setattr(settings, "ai_base_url", MODEL_URL)
    monkeypatch.setattr(settings, "ai_model", MODEL)
    monkeypatch.setattr(settings, "ai_api_key", SecretStr(KEY))
    return net


@pytest.fixture
def owner_of(
    make_tenant: Callable[..., Tenant], make_person: Callable[..., Person]
) -> Callable[[str], tuple[Tenant, Person]]:
    """A new organization, and its owner holding the dashboard key."""

    def _make(label: str) -> tuple[Tenant, Person]:
        tenant = make_tenant(label)
        return tenant, make_person(tenant, "Balaji N", [READ])

    return _make


def problem(response) -> dict:  # type: ignore[no-untyped-def]
    return response.json()["detail"]["problem"]


def digests_of(admin: psycopg.Connection, tenant: Tenant) -> int:
    with admin.cursor() as cur:
        cur.execute("SELECT count(*) FROM ai.industry_digests WHERE organization_id = %s", (tenant.org_id,))
        return cur.fetchone()[0]


# ---------------------------------------------------------------- who may


async def test_the_news_needs_a_session_and_the_dashboard_key(  # type: ignore[no-untyped-def]
    api, owner_of, make_person, net: FakeNet
) -> None:
    tenant, owner = owner_of("news-perm")
    clerk = make_person(tenant, "Ganesan K", ["stores.indent.read", "fleet.board.read"])

    assert (await api().get("/insights/industry")).status_code == 401
    assert (await api().post(REFRESH)).status_code == 401
    for response in (await api(clerk).get("/insights/industry"), await api(clerk).post(REFRESH)):
        assert response.status_code == 403
        assert response.json()["detail"] == f"Missing permission: {READ}"
    assert net.seen == [], "a refused refresh fetches nothing"
    assert (await api(owner).get("/insights/industry")).status_code == 200


async def test_before_any_refresh_there_is_no_digest(api, owner_of, net: FakeNet) -> None:  # type: ignore[no-untyped-def]
    _, owner = owner_of("news-empty")
    r = await api(owner).get("/insights/industry")
    assert r.status_code == 200 and r.json() == {"digest": None, "stale": True, "nextRefreshAt": None}


# ---------------------------------------------------------------- refreshing


async def test_a_refresh_builds_keeps_and_returns_the_digest(  # type: ignore[no-untyped-def]
    api, owner_of, with_model: FakeNet, admin: psycopg.Connection
) -> None:
    tenant, owner = owner_of("news-refresh")
    with_model.replies.append(model_reply([line(2), line(4)]))

    r = await api(owner).post(REFRESH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"digest", "stale", "nextRefreshAt"} and body["stale"] is False
    digest = body["digest"]
    assert set(digest) == {"id", "createdAt", "status", "model", "headlinesRead", "items"}
    assert (digest["status"], digest["model"], digest["headlinesRead"]) == ("summarised", MODEL, 7)
    first, second = digest["items"]
    assert set(first) == {"title", "source", "publishedAt", "link", "summary", "why"}
    assert (first["title"], first["source"], first["link"]) == (MSAND, "DT Next", article(MSAND))
    assert first["summary"] == {"en": "Plain line about headline 2.", "ta": "செய்தி 2 பற்றி ஒரு எளிய வரி."}
    assert first["why"] == {"en": "Why headline 2 matters to us.", "ta": "செய்தி 2 நமக்கு ஏன் முக்கியம்."}
    assert second["title"] == METRO
    created = datetime.fromisoformat(digest["createdAt"])
    assert datetime.fromisoformat(body["nextRefreshAt"]) == created + timedelta(hours=1)

    # The screen's next read gets the same digest.
    again = (await api(owner).get("/insights/industry")).json()
    assert again["digest"] == digest and again["stale"] is False

    # Kept with what makes it traceable: who asked, which model, which prompt,
    # what it read (numbered as the model saw it) and what it said.
    with admin.cursor() as cur:
        cur.execute(
            """
            SELECT organization_id, requested_by, model, prompt_version, reply,
                   jsonb_array_length(headlines), headlines -> 1 ->> 'link'
            FROM ai.industry_digests WHERE id = %s
            """,
            (digest["id"],),
        )
        org, requested_by, model, prompt, reply, read, second_headline = cur.fetchone()
    assert (org, requested_by, model, prompt) == (tenant.org_id, owner.user_id, MODEL, PROMPT_VERSION)
    assert read == 7 and second_headline == article(MSAND) and '"n": 2' in reply


async def test_with_no_model_the_owner_still_gets_headlines(api, owner_of, net: FakeNet) -> None:  # type: ignore[no-untyped-def]
    _, owner = owner_of("news-ai-off")
    digest = (await api(owner).post(REFRESH)).json()["digest"]
    assert (digest["status"], digest["model"]) == ("ai_off", None)
    assert [i["title"] for i in digest["items"]][:2] == [MSAND, TENDERS]
    assert all(i["summary"] is None and i["why"] is None for i in digest["items"])
    assert all(i["link"] == article(i["title"]) for i in digest["items"])


async def test_a_model_that_fails_still_leaves_headlines(api, owner_of, with_model: FakeNet) -> None:  # type: ignore[no-untyped-def]
    _, owner = owner_of("news-ai-failed")
    with_model.replies += [model_reply("no JSON here"), model_reply("still none")]
    r = await api(owner).post(REFRESH)
    assert r.status_code == 200
    digest = r.json()["digest"]
    assert (digest["status"], digest["model"]) == ("ai_failed", None)
    assert [i["title"] for i in digest["items"]][:2] == [MSAND, TENDERS]


async def test_a_second_refresh_within_the_hour_gets_a_polite_429(  # type: ignore[no-untyped-def]
    api, owner_of, make_person, net: FakeNet, admin: psycopg.Connection
) -> None:
    tenant, owner = owner_of("news-429")
    first = await api(owner).post(REFRESH)
    assert first.status_code == 200
    fetched = len(net.seen)

    again = await api(owner).post(REFRESH)
    assert again.status_code == 429
    refused = problem(again)
    assert refused["code"] == "too-soon" and 3500 < refused["retryAfterSeconds"] <= 3600
    assert again.headers["Retry-After"] == str(refused["retryAfterSeconds"])
    assert datetime.fromisoformat(refused["nextRefreshAt"]) == datetime.fromisoformat(
        first.json()["nextRefreshAt"]
    )

    # The limit is the organization's, not one person's.
    colleague = make_person(tenant, "Meenakshi S", [READ])
    assert (await api(colleague).post(REFRESH)).status_code == 429
    assert len(net.seen) == fetched, "a refused refresh fetches nothing"
    assert digests_of(admin, tenant) == 1


async def test_a_refresh_while_another_is_running_is_turned_away(  # type: ignore[no-untyped-def]
    api, owner_of, net: FakeNet, admin: psycopg.Connection
) -> None:
    tenant, owner = owner_of("news-running")
    key = f"linck.industry_digest:{tenant.org_id}"
    with admin.cursor() as cur:
        cur.execute("SELECT pg_advisory_lock(hashtextextended(%s, 0))", (key,))
    try:
        r = await api(owner).post(REFRESH)
    finally:
        with admin.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", (key,))
    assert r.status_code == 429 and problem(r) == {"code": "refresh-running", "retryAfterSeconds": 60}
    assert net.seen == [] and digests_of(admin, tenant) == 0


async def test_when_no_feed_can_be_read_nothing_is_kept(  # type: ignore[no-untyped-def]
    api, owner_of, net: FakeNet, admin: psycopg.Connection
) -> None:
    tenant, owner = owner_of("news-502")
    net.feeds = dict.fromkeys(QUERIES, 503)
    r = await api(owner).post(REFRESH)
    assert r.status_code == 502 and problem(r) == {"code": "news-unavailable"}
    assert digests_of(admin, tenant) == 0
    # Nothing was kept, so nothing holds the next try back.
    net.feeds = two_feeds(datetime.now(UTC))
    assert (await api(owner).post(REFRESH)).status_code == 200


async def test_a_digest_older_than_a_week_is_stale_and_may_be_refreshed(  # type: ignore[no-untyped-def]
    api, owner_of, net: FakeNet, admin: psycopg.Connection
) -> None:
    tenant, owner = owner_of("news-stale")
    old = datetime.now(UTC) - timedelta(days=8)
    item = {
        "title": "An old headline",
        "source": "The Hindu",
        "published_at": (old - timedelta(hours=3)).isoformat(),
        "link": article("An old headline"),
        "summary": None,
        "why": None,
    }
    with admin.cursor() as cur:
        cur.execute(
            "INSERT INTO ai.industry_digests (organization_id, status, items, created_at)"
            " VALUES (%s, 'ai_off', %s::jsonb, %s)",
            (tenant.org_id, json.dumps([item]), old),
        )
    got = (await api(owner).get("/insights/industry")).json()
    assert got["stale"] is True and got["nextRefreshAt"] is None
    assert [i["title"] for i in got["digest"]["items"]] == ["An old headline"]

    fresh = await api(owner).post(REFRESH)
    assert fresh.status_code == 200 and fresh.json()["stale"] is False


# ---------------------------------------------------------------- tenants


async def test_another_tenant_can_neither_see_nor_touch_a_digest(  # type: ignore[no-untyped-def]
    api, owner_of, net: FakeNet, admin: psycopg.Connection
) -> None:
    a, owner_a = owner_of("news-iso-a")
    b, owner_b = owner_of("news-iso-b")
    made = (await api(owner_a).post(REFRESH)).json()["digest"]

    # B's screen shows B's news, which is none, and never A's.
    assert (await api(owner_b).get("/insights/industry")).json()["digest"] is None

    async with tenant_session(b.org_id) as db:
        assert (await db.scalars(select(IndustryDigest))).all() == []
        changed = await db.execute(
            text("UPDATE ai.industry_digests SET error = 'touched' WHERE id = :id"), {"id": made["id"]}
        )
        removed = await db.execute(text("DELETE FROM ai.industry_digests WHERE id = :id"), {"id": made["id"]})
    assert changed.rowcount == 0 and removed.rowcount == 0

    with pytest.raises(DBAPIError) as planted:
        async with tenant_session(b.org_id) as db:
            await db.execute(
                text("INSERT INTO ai.industry_digests (organization_id, status) VALUES (:org, 'ai_off')"),
                {"org": str(a.org_id)},
            )
    assert "row-level security" in str(planted.value).lower()

    # Without a tenant, nothing at all.
    async with tenant_session(None) as db:
        assert (await db.execute(text("SELECT count(*) FROM ai.industry_digests"))).scalar_one() == 0

    # Ground truth, read past RLS: A's digest is there, once, untouched.
    with admin.cursor() as cur:
        cur.execute(
            "SELECT count(*), max(error) FROM ai.industry_digests WHERE organization_id = %s", (a.org_id,)
        )
        assert cur.fetchone() == (1, None)


async def test_a_digest_cannot_name_another_tenants_user(owner_of) -> None:  # type: ignore[no-untyped-def]
    a, owner_a = owner_of("news-fk-a")
    b, _ = owner_of("news-fk-b")
    with pytest.raises(DBAPIError) as crossed:
        async with tenant_session(b.org_id) as db:
            await db.execute(
                text(
                    "INSERT INTO ai.industry_digests (organization_id, status, requested_by)"
                    " VALUES (:org, 'ai_off', :user)"
                ),
                {"org": str(b.org_id), "user": str(owner_a.user_id)},
            )
    assert "fk_industry_digests_organization_id_requested_by" in str(crossed.value)


# ---------------------------------------------------------------- the table


def test_the_app_role_has_on_digests_exactly_what_it_has_on_core_tables(admin: psycopg.Connection) -> None:
    with admin.cursor() as cur:
        cur.execute(
            """
            SELECT t, array_agg(p ORDER BY p) FILTER (WHERE has_table_privilege(%s, t, p))
            FROM unnest(ARRAY['ai.industry_digests', 'core.sites']) t,
                 unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
            GROUP BY t
            """,
            (APP_ROLE,),
        )
        grants = dict(cur.fetchall())
        cur.execute(
            "SELECT has_schema_privilege(%s, 'ai', 'USAGE'), has_schema_privilege(%s, 'ai', 'CREATE')",
            (APP_ROLE, APP_ROLE),
        )
        schema = cur.fetchone()
    assert grants["ai.industry_digests"] == grants["core.sites"] == ["DELETE", "INSERT", "SELECT", "UPDATE"]
    assert schema == (True, False)


async def test_each_digest_is_in_the_audit_log(  # type: ignore[no-untyped-def]
    api, owner_of, net: FakeNet, admin: psycopg.Connection
) -> None:
    tenant, owner = owner_of("news-audit")
    made = (await api(owner).post(REFRESH)).json()["digest"]
    with admin.cursor() as cur:
        cur.execute(
            "SELECT action, organization_id, actor_user_id FROM core.audit_logs"
            " WHERE entity_table = 'ai.industry_digests' AND entity_id = %s",
            (made["id"],),
        )
        assert cur.fetchall() == [("insert", tenant.org_id, owner.user_id)]
