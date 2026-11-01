"""Who may do what has a history: the access tables carry the audit trigger.

A role, the keys it grants, who holds it where, an invitation, the Google
account a person signs in with: a change to any of them changes what someone
can see or do, so each is audited like a bill or a site (migration 0021).

Most writes to these tables happen with no tenant context: a fixture like the
ones in conftest.py, a data fix in psql, a backfill. The trigger runs as
linck_audit, which may append to the log under any GUC (migration 0005), and
takes the tenant from the row itself, so such a write is recorded, and shows in
that tenant's own audit view and in no other's. Sign-in writes under the tenant
the resolvers found, so it is attributed to the person signing in as well.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass

import psycopg
import pytest
from conftest import Tenant
from sqlalchemy import text

from app.core.db import tenant_session


@dataclass(frozen=True)
class Access:
    tenant: Tenant
    user_id: uuid.UUID
    role_id: uuid.UUID


@pytest.fixture(scope="module")
def access(
    admin: psycopg.Connection, make_tenant: Callable[..., Tenant], make_user: Callable[..., uuid.UUID]
) -> Access:
    tenant = make_tenant("access-audit")
    user_id = make_user(tenant, f"audited-{uuid.uuid4().hex[:10]}@example.com", "Audited Person")
    role_id = uuid.uuid4()
    with admin.cursor() as cur:
        cur.execute(
            "INSERT INTO core.roles (id, organization_id, key, label) VALUES (%s, %s, %s, 'Audited role')",
            (role_id, tenant.org_id, f"zz-audited-{role_id.hex[:8]}"),
        )
    return Access(tenant, user_id, role_id)


# One row in each table that says who may do what, and in the two other core
# tables 0021 audits: how to plant it, and one change to make to it.
WRITES = {
    "core.roles": (
        "INSERT INTO core.roles (id, organization_id, key, label)"
        " VALUES (%(id)s, %(org)s, %(tag)s, 'Planted')",
        "UPDATE core.roles SET label = 'Renamed' WHERE id = %(id)s",
    ),
    "core.role_permissions": (
        "INSERT INTO core.role_permissions (id, organization_id, role_id, permission_key)"
        " VALUES (%(id)s, %(org)s, %(role)s, 'fleet.expense.read')",
        "UPDATE core.role_permissions SET permission_key = 'finance.expense.pay' WHERE id = %(id)s",
    ),
    "core.role_assignments": (
        "INSERT INTO core.role_assignments (id, organization_id, user_id, role_id)"
        " VALUES (%(id)s, %(org)s, %(user)s, %(role)s)",
        "UPDATE core.role_assignments SET site_id = %(site)s WHERE id = %(id)s",
    ),
    "core.invitations": (
        "INSERT INTO core.invitations (id, organization_id, email, full_name, expires_at)"
        " VALUES (%(id)s, %(org)s, %(tag)s || '@example.com', 'Invited', now() + interval '7 days')",
        "UPDATE core.invitations SET accepted_at = now() WHERE id = %(id)s",
    ),
    "core.user_identities": (
        "INSERT INTO core.user_identities (id, organization_id, user_id, provider, subject, email)"
        " VALUES (%(id)s, %(org)s, %(user)s, 'google', %(tag)s, 'audited@example.com')",
        "UPDATE core.user_identities SET last_login_at = now() WHERE id = %(id)s",
    ),
    "core.gst_registrations": (
        "INSERT INTO core.gst_registrations"
        " (id, organization_id, legal_entity_id, gstin, state_code, legal_name)"
        " VALUES (%(id)s, %(org)s, %(entity)s, %(gstin)s, '33', 'Planted Minerals')",
        "UPDATE core.gst_registrations SET e_invoicing_applicable = true WHERE id = %(id)s",
    ),
    "core.whatsapp_messages": (
        "INSERT INTO core.whatsapp_messages"
        " (id, organization_id, wamid, phone_number_id, from_phone, sent_at, kind)"
        " VALUES (%(id)s, %(org)s, %(tag)s, '109876543210', '919578246168', now(), 'image')",
        "UPDATE core.whatsapp_messages SET imported_at = now(), imported_by = %(user)s WHERE id = %(id)s",
    ),
}

IN_AUDIT_VIEW = text("SELECT count(*) FROM core.audit_logs WHERE entity_table = :table AND entity_id = :id")


@pytest.mark.parametrize("table", list(WRITES))
async def test_a_write_with_no_tenant_context_is_audited_under_its_tenant(
    table: str, access: Access, tenant_b: Tenant, admin: psycopg.Connection
) -> None:
    row_id = uuid.uuid4()
    tenant = access.tenant
    params = {
        "id": row_id,
        "org": tenant.org_id,
        "user": access.user_id,
        "role": access.role_id,
        "site": tenant.site_id,
        "entity": tenant.legal_entity_id,
        "tag": f"zz-audited-{row_id.hex[:12]}",
        "gstin": f"33{row_id.hex[:10].upper()}1Z5",
    }
    insert, update = WRITES[table]
    with admin.cursor() as cur:
        cur.execute("SELECT nullif(current_setting('app.current_org_id', true), '')")
        assert cur.fetchone() == (None,), "this connection has a tenant context, so the test proves nothing"
        cur.execute(insert, params)
        cur.execute(update, params)
        cur.execute(f"DELETE FROM {table} WHERE id = %s", (row_id,))
        cur.execute(
            "SELECT action, organization_id, actor_user_id FROM core.audit_logs"
            " WHERE entity_table = %s AND entity_id = %s",
            (table, row_id),
        )
        logged = sorted(cur.fetchall())
    # Attributed to the row's tenant, and to nobody in particular: no request named an actor.
    org = tenant.org_id
    assert logged == [("delete", org, None), ("insert", org, None), ("update", org, None)]

    params = {"table": table, "id": str(row_id)}
    async with tenant_session(tenant.org_id) as db:
        mine = (await db.execute(IN_AUDIT_VIEW, params)).scalar_one()
    async with tenant_session(tenant_b.org_id) as db:
        theirs = (await db.execute(IN_AUDIT_VIEW, params)).scalar_one()
    assert (mine, theirs) == (3, 0)


async def test_signing_in_is_audited_and_its_session_is_not(  # type: ignore[no-untyped-def]
    api, access: Access, make_user: Callable[..., uuid.UUID], admin: psycopg.Connection
) -> None:
    """The first sign-in pins the account (dev-login's stand-in for a Google
    one) and accepts the invitation; the next goes through core.resolve_identity
    and stamps the identity. Sessions are not audited: each row holds the hash
    its refresh token is looked up by."""
    tenant = access.tenant
    email = f"signing-in-{uuid.uuid4().hex[:10]}@example.com"
    user_id = make_user(tenant, email, "Selvi K", status="invited")
    invitation_id = uuid.uuid4()
    with admin.cursor() as cur:
        cur.execute(
            "INSERT INTO core.invitations (id, organization_id, email, full_name, expires_at)"
            " VALUES (%s, %s, %s, 'Selvi K', now() + interval '7 days')",
            (invitation_id, tenant.org_id, email),
        )

    for _ in range(2):
        r = await api().post("/auth/dev-login", json={"email": email})
        assert r.status_code == 200, r.text

    with admin.cursor() as cur:
        cur.execute("SELECT id FROM core.user_identities WHERE user_id = %s", (user_id,))
        [(identity_id,)] = cur.fetchall()
        cur.execute(
            "SELECT entity_table, action, organization_id, actor_user_id FROM core.audit_logs"
            " WHERE entity_id IN (%s, %s)",
            (invitation_id, identity_id),
        )
        logged = sorted(cur.fetchall())
        cur.execute("SELECT count(*) FROM core.sessions WHERE user_id = %s", (user_id,))
        [sessions] = cur.fetchone()
        cur.execute("SELECT count(*) FROM core.audit_logs WHERE entity_table = 'core.sessions'")
        [sessions_logged] = cur.fetchone()

    assert logged == [
        ("core.invitations", "insert", tenant.org_id, None),  # planted here, with no tenant context
        ("core.invitations", "update", tenant.org_id, user_id),  # accepted by the first sign-in
        ("core.user_identities", "insert", tenant.org_id, user_id),  # pinned by the first
        ("core.user_identities", "update", tenant.org_id, user_id),  # stamped by the second
    ]
    assert (sessions, sessions_logged) == (2, 0)
