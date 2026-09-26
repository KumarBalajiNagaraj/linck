from logging.config import fileConfig

from alembic import context
from sqlalchemy import Connection, create_engine, pool, text

from app.core.settings import get_settings
from app.models.base import Base

# Importing for the side effect of registering every model on Base.metadata.
# Without this, autogenerate cheerfully proposes dropping the whole schema.
import app.models.core  # noqa: F401

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

# Migrations run as the migration role over a sync driver. The app's async
# engine is deliberately not reused: Alembic is synchronous, and the migration
# role has privileges the app role must never hold.
settings = get_settings()

SCHEMAS = ("core",)

# Alembic's version table lives in a schema the migration role creates and owns.
#
# Not public: Postgres 15+ stopped granting CREATE there to every role, and
# handing it back to the migrator would let that role plant objects on every
# other role's search_path.
# Not core: the app role gets DML on every core table through init-roles.sql's
# default privileges, and check_rls_posture() refuses to boot while core holds a
# table without row level security.
VERSION_SCHEMA = "alembic"


def include_object(obj, name, type_, reflected, compare_to):
    """Keep autogenerate inside our own schemas."""
    if type_ == "table":
        return obj.schema in SCHEMAS
    return True


def move_version_table_out_of_public(connection: Connection) -> None:
    """Adopt the version table this file used to keep in public.

    Only a table that provably holds our history is moved: an empty one records
    nothing, and one stamped with revisions we do not have belongs to some other
    project sharing the database.
    """
    in_public, in_ours = connection.execute(
        text("SELECT to_regclass('public.alembic_version') IS NOT NULL, to_regclass(:ours) IS NOT NULL"),
        {"ours": f"{VERSION_SCHEMA}.alembic_version"},
    ).one()
    if not in_public or in_ours:
        return
    stamped = set(connection.execute(text("SELECT version_num FROM public.alembic_version")).scalars())
    ours = {script.revision for script in context.script.walk_revisions()}
    if stamped and stamped <= ours:
        connection.execute(text(f"ALTER TABLE public.alembic_version SET SCHEMA {VERSION_SCHEMA}"))


def run_migrations_offline() -> None:
    context.configure(
        url=settings.migration_database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        include_schemas=True,
        include_object=include_object,
        version_table_schema=VERSION_SCHEMA,
    )
    with context.begin_transaction():
        context.execute(f"CREATE SCHEMA IF NOT EXISTS {VERSION_SCHEMA}")
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(settings.migration_database_url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_schemas=True,
            include_object=include_object,
            version_table_schema=VERSION_SCHEMA,
            compare_type=True,
        )
        with context.begin_transaction():
            context.execute(f"CREATE SCHEMA IF NOT EXISTS {VERSION_SCHEMA}")
            move_version_table_out_of_public(connection)
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
