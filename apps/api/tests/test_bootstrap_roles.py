"""scripts/bootstrap_roles.py, the managed-cluster twin of scripts/init-roles.sql.

Roles are cluster-wide, so this suite never runs the bootstrap for real: that
would rewrite the passwords of roles other databases on the same server use.
What it does prove is that the bootstrap's own check finds the test database,
which init-roles.sql and the migrations set up, exactly as the bootstrap would
leave a managed one; and that the URLs it prints are the ones each driver takes.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import psycopg
import pytest
from conftest import ADMIN_URL, DATABASE
from sqlalchemy.engine import make_url

_PATH = Path(__file__).resolve().parents[1] / "scripts" / "bootstrap_roles.py"
_SPEC = importlib.util.spec_from_file_location("bootstrap_roles", _PATH)
assert _SPEC is not None and _SPEC.loader is not None
bootstrap = importlib.util.module_from_spec(_SPEC)
# Registered before it runs: its dataclass looks itself up there.
sys.modules[_SPEC.name] = bootstrap
_SPEC.loader.exec_module(bootstrap)


def test_the_check_finds_the_test_database_as_init_roles_left_it(admin: psycopg.Connection) -> None:
    assert bootstrap.verify(admin) == []


def test_check_mode_reads_and_exits_zero(monkeypatch: pytest.MonkeyPatch, capsys) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("LINCK_ADMIN_URL", ADMIN_URL)
    assert bootstrap.main(["--database", DATABASE, "--check"]) == 0
    assert "none SUPERUSER or BYPASSRLS" in capsys.readouterr().out


def test_the_printed_urls_are_the_ones_each_driver_takes() -> None:
    urls = bootstrap.database_urls(
        "postgresql://doadmin:admin-secret@db-linck.example.com:25060/defaultdb?sslmode=require",
        "linck",
        {"linck_app": "app/pass word", "linck_migrator": "migrator-pass"},
    )
    app, migrator = make_url(urls["LINCK_DATABASE_URL"]), make_url(urls["LINCK_MIGRATION_DATABASE_URL"])
    # asyncpg is handed every query parameter as a keyword, and has no `sslmode`.
    assert (app.drivername, app.username, app.password, app.query) == (
        "postgresql+asyncpg",
        "linck_app",
        "app/pass word",
        {"ssl": "require"},
    )
    assert (migrator.drivername, migrator.username, migrator.query) == (
        "postgresql+psycopg",
        "linck_migrator",
        {"sslmode": "require"},
    )
    for url in (app, migrator):
        assert (url.host, url.port, url.database) == ("db-linck.example.com", 25060, "linck")
    # The admin's own credentials go nowhere near the app.
    assert not any("admin-secret" in value or "doadmin" in value for value in urls.values())


def test_weak_or_shared_passwords_are_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LINCK_MIGRATOR_PASSWORD", "too-short")
    monkeypatch.setenv("LINCK_APP_PASSWORD", "x" * 32)
    with pytest.raises(bootstrap.Refused, match="LINCK_MIGRATOR_PASSWORD"):
        bootstrap.passwords_from_env()
    monkeypatch.setenv("LINCK_MIGRATOR_PASSWORD", "x" * 32)
    with pytest.raises(bootstrap.Refused, match="differ"):
        bootstrap.passwords_from_env()
