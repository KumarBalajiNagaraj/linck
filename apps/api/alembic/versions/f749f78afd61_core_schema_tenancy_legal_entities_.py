"""core schema: tenancy, legal entities, identity, scoped rbac

Revision ID: f749f78afd61
Revises: 
Create Date: 2026-08-08 22:39:42.500486

"""
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'f749f78afd61'
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute('CREATE SCHEMA IF NOT EXISTS core')

    op.create_table('organizations',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('display_name', sa.Text(), nullable=False),
    sa.Column('slug', sa.Text(), nullable=False),
    sa.Column('base_currency', sa.String(length=3), server_default=sa.text("'INR'"), nullable=False),
    sa.Column('timezone', sa.Text(), server_default=sa.text("'Asia/Kolkata'"), nullable=False),
    sa.Column('fiscal_year_start_month', sa.Integer(), server_default=sa.text('4'), nullable=False),
    sa.Column('google_hosted_domains', postgresql.ARRAY(sa.Text()), server_default=sa.text("'{}'"), nullable=False),
    sa.Column('segregation_enforcement', sa.Text(), server_default=sa.text("'review_queue'"), nullable=False),
    sa.Column('settings', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
    sa.Column('status', sa.Text(), server_default=sa.text("'active'"), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_organizations')),
    sa.UniqueConstraint('slug', name=op.f('uq_organizations_slug')),
    schema='core'
    )
    op.create_table('permissions',
    sa.Column('key', sa.Text(), nullable=False),
    sa.Column('module', sa.Text(), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.PrimaryKeyConstraint('key', name=op.f('pk_permissions')),
    schema='core'
    )
    op.create_table('audit_logs',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=True),
    sa.Column('actor_user_id', sa.UUID(), nullable=True),
    sa.Column('action', sa.Text(), nullable=False),
    sa.Column('entity_table', sa.Text(), nullable=False),
    sa.Column('entity_id', sa.UUID(), nullable=True),
    sa.Column('before', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('after', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('request_id', sa.Text(), nullable=True),
    sa.Column('ip', postgresql.INET(), nullable=True),
    sa.Column('at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['organization_id'], ['core.organizations.id'], name=op.f('fk_audit_logs_organization_id'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_audit_logs')),
    schema='core'
    )
    op.create_index('ix_audit_logs_at', 'audit_logs', ['at'], unique=False, schema='core')
    op.create_index('ix_audit_logs_entity', 'audit_logs', ['entity_table', 'entity_id'], unique=False, schema='core')
    op.create_index(op.f('ix_core_audit_logs_organization_id'), 'audit_logs', ['organization_id'], unique=False, schema='core')
    op.create_table('invitations',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('email', sa.Text(), nullable=False),
    sa.Column('full_name', sa.Text(), nullable=False),
    sa.Column('invited_by', sa.UUID(), nullable=True),
    sa.Column('accepted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['organization_id'], ['core.organizations.id'], name=op.f('fk_invitations_organization_id'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_invitations')),
    sa.UniqueConstraint('organization_id', 'email', name='uq_invitations_organization_id_email'),
    schema='core'
    )
    op.create_index(op.f('ix_core_invitations_organization_id'), 'invitations', ['organization_id'], unique=False, schema='core')
    op.create_table('legal_entities',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('code', sa.Text(), nullable=False),
    sa.Column('legal_name', sa.Text(), nullable=False),
    sa.Column('trade_name', sa.Text(), nullable=True),
    sa.Column('entity_type', sa.Text(), nullable=False),
    sa.Column('pan', sa.String(length=10), nullable=True),
    sa.Column('is_goods_transport_agency', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("entity_type in ('proprietorship','partnership','llp','private_limited','public_limited','huf','trust')", name=op.f('ck_legal_entities_entity_type_known')),
    sa.ForeignKeyConstraint(['organization_id'], ['core.organizations.id'], name=op.f('fk_legal_entities_organization_id'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_legal_entities')),
    sa.UniqueConstraint('organization_id', 'code', name='uq_legal_entities_organization_id_code'),
    sa.UniqueConstraint('organization_id', 'id', name='uq_legal_entities_organization_id_id'),
    schema='core'
    )
    op.create_index(op.f('ix_core_legal_entities_organization_id'), 'legal_entities', ['organization_id'], unique=False, schema='core')
    op.create_table('organization_modules',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('module', sa.Text(), nullable=False),
    sa.Column('enabled', sa.Boolean(), server_default=sa.text('true'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("module in ('fleet','production','sales','stores','finance','compliance','ai')", name=op.f('ck_organization_modules_module_known')),
    sa.ForeignKeyConstraint(['organization_id'], ['core.organizations.id'], name=op.f('fk_organization_modules_organization_id'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_organization_modules')),
    sa.UniqueConstraint('organization_id', 'module', name='uq_organization_modules_organization_id_module'),
    schema='core'
    )
    op.create_index(op.f('ix_core_organization_modules_organization_id'), 'organization_modules', ['organization_id'], unique=False, schema='core')
    op.create_table('roles',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('key', sa.Text(), nullable=False),
    sa.Column('label', sa.Text(), nullable=False),
    sa.Column('is_system', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['organization_id'], ['core.organizations.id'], name=op.f('fk_roles_organization_id'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_roles')),
    sa.UniqueConstraint('organization_id', 'key', name='uq_roles_organization_id_key'),
    schema='core'
    )
    op.create_index(op.f('ix_core_roles_organization_id'), 'roles', ['organization_id'], unique=False, schema='core')
    op.create_table('users',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('email', sa.Text(), nullable=False),
    sa.Column('full_name', sa.Text(), nullable=False),
    sa.Column('phone', sa.String(length=15), nullable=True),
    sa.Column('employee_code', sa.Text(), nullable=True),
    sa.Column('avatar_url', sa.Text(), nullable=True),
    sa.Column('status', sa.Text(), server_default=sa.text("'invited'"), nullable=False),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('default_route', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['organization_id'], ['core.organizations.id'], name=op.f('fk_users_organization_id'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_users')),
    sa.UniqueConstraint('organization_id', 'email', name='uq_users_organization_id_email'),
    sa.UniqueConstraint('organization_id', 'id', name='uq_users_organization_id_id'),
    schema='core'
    )
    op.create_index(op.f('ix_core_users_organization_id'), 'users', ['organization_id'], unique=False, schema='core')
    op.create_table('gst_registrations',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('legal_entity_id', sa.UUID(), nullable=False),
    sa.Column('gstin', sa.String(length=15), nullable=False),
    sa.Column('state_code', sa.String(length=2), nullable=False),
    sa.Column('legal_name', sa.Text(), nullable=False),
    sa.Column('e_invoicing_applicable', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('char_length(gstin) = 15', name=op.f('ck_gst_registrations_gstin_length')),
    sa.ForeignKeyConstraint(['legal_entity_id'], ['core.legal_entities.id'], name=op.f('fk_gst_registrations_legal_entity_id')),
    sa.ForeignKeyConstraint(['organization_id'], ['core.organizations.id'], name=op.f('fk_gst_registrations_organization_id'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_gst_registrations')),
    sa.UniqueConstraint('organization_id', 'gstin', name='uq_gst_registrations_organization_id_gstin'),
    schema='core'
    )
    op.create_index(op.f('ix_core_gst_registrations_organization_id'), 'gst_registrations', ['organization_id'], unique=False, schema='core')
    op.create_table('role_permissions',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('role_id', sa.UUID(), nullable=False),
    sa.Column('permission_key', sa.Text(), nullable=False),
    sa.ForeignKeyConstraint(['organization_id'], ['core.organizations.id'], name=op.f('fk_role_permissions_organization_id'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['permission_key'], ['core.permissions.key'], name=op.f('fk_role_permissions_permission_key')),
    sa.ForeignKeyConstraint(['role_id'], ['core.roles.id'], name=op.f('fk_role_permissions_role_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_role_permissions')),
    sa.UniqueConstraint('role_id', 'permission_key', name='uq_role_permissions_role_id_permission_key'),
    schema='core'
    )
    op.create_index(op.f('ix_core_role_permissions_organization_id'), 'role_permissions', ['organization_id'], unique=False, schema='core')
    op.create_table('sessions',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('refresh_token_hash', sa.Text(), nullable=False),
    sa.Column('replaces_session_id', sa.UUID(), nullable=True),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('revoked_reason', sa.Text(), nullable=True),
    sa.Column('user_agent', sa.Text(), nullable=True),
    sa.Column('ip', postgresql.INET(), nullable=True),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['organization_id'], ['core.organizations.id'], name=op.f('fk_sessions_organization_id'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['user_id'], ['core.users.id'], name=op.f('fk_sessions_user_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_sessions')),
    schema='core'
    )
    op.create_index(op.f('ix_core_sessions_organization_id'), 'sessions', ['organization_id'], unique=False, schema='core')
    op.create_index('ix_sessions_expires_at', 'sessions', ['expires_at'], unique=False, schema='core')
    op.create_index('ix_sessions_user_id', 'sessions', ['user_id'], unique=False, schema='core')
    op.create_table('user_identities',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('provider', sa.Text(), server_default=sa.text("'google'"), nullable=False),
    sa.Column('subject', sa.Text(), nullable=False),
    sa.Column('email', sa.Text(), nullable=False),
    sa.Column('email_verified', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    sa.Column('hosted_domain', sa.Text(), nullable=True),
    sa.Column('linked_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['organization_id'], ['core.organizations.id'], name=op.f('fk_user_identities_organization_id'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['user_id'], ['core.users.id'], name=op.f('fk_user_identities_user_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_user_identities')),
    sa.UniqueConstraint('provider', 'subject', name='uq_user_identities_provider_subject'),
    schema='core'
    )
    op.create_index(op.f('ix_core_user_identities_organization_id'), 'user_identities', ['organization_id'], unique=False, schema='core')
    op.create_index('ix_user_identities_user_id', 'user_identities', ['user_id'], unique=False, schema='core')
    op.create_table('sites',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('legal_entity_id', sa.UUID(), nullable=False),
    sa.Column('gst_registration_id', sa.UUID(), nullable=True),
    sa.Column('code', sa.Text(), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('site_type', sa.Text(), nullable=False),
    sa.Column('state_code', sa.String(length=2), nullable=False),
    sa.Column('address', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
    sa.Column('is_active', sa.Boolean(), server_default=sa.text('true'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("site_type in ('head_office','quarry','crusher_plant','stockyard','depot','workshop','weighbridge_point','fuel_point')", name=op.f('ck_sites_site_type_known')),
    sa.ForeignKeyConstraint(['gst_registration_id'], ['core.gst_registrations.id'], name=op.f('fk_sites_gst_registration_id')),
    sa.ForeignKeyConstraint(['legal_entity_id'], ['core.legal_entities.id'], name=op.f('fk_sites_legal_entity_id')),
    sa.ForeignKeyConstraint(['organization_id'], ['core.organizations.id'], name=op.f('fk_sites_organization_id'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_sites')),
    sa.UniqueConstraint('organization_id', 'code', name='uq_sites_organization_id_code'),
    sa.UniqueConstraint('organization_id', 'id', name='uq_sites_organization_id_id'),
    schema='core'
    )
    op.create_index(op.f('ix_core_sites_organization_id'), 'sites', ['organization_id'], unique=False, schema='core')
    op.create_table('role_assignments',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('role_id', sa.UUID(), nullable=False),
    sa.Column('site_id', sa.UUID(), nullable=True),
    sa.Column('granted_by', sa.UUID(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['organization_id'], ['core.organizations.id'], name=op.f('fk_role_assignments_organization_id'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['role_id'], ['core.roles.id'], name=op.f('fk_role_assignments_role_id'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['site_id'], ['core.sites.id'], name=op.f('fk_role_assignments_site_id'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['core.users.id'], name=op.f('fk_role_assignments_user_id'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_role_assignments')),
    schema='core'
    )
    op.create_index(op.f('ix_core_role_assignments_organization_id'), 'role_assignments', ['organization_id'], unique=False, schema='core')
    op.create_index('ix_role_assignments_user_id', 'role_assignments', ['user_id'], unique=False, schema='core')
    op.create_index('uq_role_assignments_scope', 'role_assignments', ['user_id', 'role_id', sa.literal_column("coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid)")], unique=True, schema='core')


def downgrade() -> None:
    op.drop_index('uq_role_assignments_scope', table_name='role_assignments', schema='core')
    op.drop_index('ix_role_assignments_user_id', table_name='role_assignments', schema='core')
    op.drop_index(op.f('ix_core_role_assignments_organization_id'), table_name='role_assignments', schema='core')
    op.drop_table('role_assignments', schema='core')
    op.drop_index(op.f('ix_core_sites_organization_id'), table_name='sites', schema='core')
    op.drop_table('sites', schema='core')
    op.drop_index('ix_user_identities_user_id', table_name='user_identities', schema='core')
    op.drop_index(op.f('ix_core_user_identities_organization_id'), table_name='user_identities', schema='core')
    op.drop_table('user_identities', schema='core')
    op.drop_index('ix_sessions_user_id', table_name='sessions', schema='core')
    op.drop_index('ix_sessions_expires_at', table_name='sessions', schema='core')
    op.drop_index(op.f('ix_core_sessions_organization_id'), table_name='sessions', schema='core')
    op.drop_table('sessions', schema='core')
    op.drop_index(op.f('ix_core_role_permissions_organization_id'), table_name='role_permissions', schema='core')
    op.drop_table('role_permissions', schema='core')
    op.drop_index(op.f('ix_core_gst_registrations_organization_id'), table_name='gst_registrations', schema='core')
    op.drop_table('gst_registrations', schema='core')
    op.drop_index(op.f('ix_core_users_organization_id'), table_name='users', schema='core')
    op.drop_table('users', schema='core')
    op.drop_index(op.f('ix_core_roles_organization_id'), table_name='roles', schema='core')
    op.drop_table('roles', schema='core')
    op.drop_index(op.f('ix_core_organization_modules_organization_id'), table_name='organization_modules', schema='core')
    op.drop_table('organization_modules', schema='core')
    op.drop_index(op.f('ix_core_legal_entities_organization_id'), table_name='legal_entities', schema='core')
    op.drop_table('legal_entities', schema='core')
    op.drop_index(op.f('ix_core_invitations_organization_id'), table_name='invitations', schema='core')
    op.drop_table('invitations', schema='core')
    op.drop_index(op.f('ix_core_audit_logs_organization_id'), table_name='audit_logs', schema='core')
    op.drop_index('ix_audit_logs_entity', table_name='audit_logs', schema='core')
    op.drop_index('ix_audit_logs_at', table_name='audit_logs', schema='core')
    op.drop_table('audit_logs', schema='core')
    op.drop_table('permissions', schema='core')
    op.drop_table('organizations', schema='core')
