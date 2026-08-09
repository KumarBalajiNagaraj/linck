from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

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


def include_object(obj, name, type_, reflected, compare_to):
    """Keep autogenerate inside our own schemas."""
    if type_ == "table":
        return obj.schema in SCHEMAS
    return True


def run_migrations_offline() -> None:
    context.configure(
        url=settings.migration_database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        include_schemas=True,
        include_object=include_object,
        version_table_schema="public",
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(settings.migration_database_url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_schemas=True,
            include_object=include_object,
            version_table_schema="public",
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
