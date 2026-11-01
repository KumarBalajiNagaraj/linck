"""The system roles a tenant can hold, and the keys each grants there.

One list for scripts/seed_dev.py, which seeds the demo tenants, and for
scripts/create_org.py, which registers real companies from the deployed
image, where the seed is not. Both create a tenant's roles through
role_grants(), so a role grants the same keys whichever made it.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

#: The verticals a tenant can switch on: ck_organization_modules_module_known.
ALL_MODULES = ("fleet", "production", "sales", "stores", "finance", "compliance", "ai")


@dataclass(frozen=True)
class RoleSpec:
    label: str
    # The vertical this role belongs to. If the tenant has not switched that
    # module on, the role is not created at all — which is why a Kaveri admin
    # cannot accidentally assign someone "Fleet manager" and why Anbu has no
    # weighbridge operator. Roles with no home vertical (admin, executive,
    # accounts) exist for every tenant.
    requires_module: str | None
    permissions: tuple[str, ...]


ROLES: dict[str, RoleSpec] = {
    "org_admin": RoleSpec(
        "Administrator",
        None,
        ("admin.member.manage", "admin.org.manage", "compliance.document.read"),
    ),
    "executive": RoleSpec(
        "Managing Director",
        None,
        (
            "executive.dashboard.read",
            "fleet.board.read",
            "fleet.vehicle.read",
            "production.stock.read",
            "production.run.read",
            "sales.dispatch.read",
            "sales.trip.read",
            "sales.invoice.read",
            "finance.receipt.read",
            "finance.receipt.verify",
            "compliance.document.read",
            "compliance.ewb.read",
            "stores.indent.read",
            "stores.indent.approve",
            "ai.extraction.review",
            "sales.board.read",
            "sales.customer.read",
            "sales.order.read",
            "sales.order.approve",
            "fleet.driver.read",
            "fleet.breakdown.read",
            "fleet.expense.read",
            "stores.expense.read",
            "finance.expense.read",
            "finance.expense.approve",
            # LIN-22: every trip's profit, and the vehicle-wise, monthly and money-due reports.
            "fleet.trip_pl.read",
            "finance.pl_report.read",
        ),
    ),
    "accounts": RoleSpec(
        "Accounts",
        None,
        (
            "sales.invoice.read",
            "sales.invoice.write",
            "sales.trip.read",
            "finance.receipt.read",
            "finance.receipt.verify",
            "compliance.document.read",
            "compliance.document.write",
            "compliance.ewb.read",
            "compliance.ewb.write",
            "fleet.vehicle.read",
            "ai.extraction.review",
            "finance.expense.read",
            "finance.expense.pass",
            "finance.expense.pay",
            "fleet.trip_pl.read",
            "finance.pl_report.read",
        ),
    ),
    "fleet_manager": RoleSpec(
        "Fleet Manager",
        "fleet",
        (
            "fleet.board.read",
            "fleet.driver.read",
            "fleet.breakdown.read",
            "fleet.expense.read",
            "fleet.expense.validate",
            "fleet.expense.upload",
            "stores.expense.read",
            "stores.expense.validate",
            "fleet.vehicle.read",
            "fleet.vehicle.write",
            "fleet.fuel.create",
            "fleet.fuel.read",
            "compliance.document.read",
            "compliance.document.write",
            "compliance.ewb.read",
            "stores.indent.create",
            "stores.indent.read",
            "sales.dispatch.read",
            "sales.trip.read",
            "ai.extraction.review",
            # LIN-22: enters trips, and sees each trip's profit.
            "fleet.trip_pl.read",
            "fleet.trip_pl.write",
        ),
    ),
    "production_incharge": RoleSpec(
        "Production In-charge",
        "production",
        (
            "production.run.create",
            "production.run.read",
            "production.stock.read",
            "stores.indent.create",
            "stores.indent.read",
        ),
    ),
    "sales_coordinator": RoleSpec(
        "Sales Coordinator",
        "sales",
        (
            "sales.board.read",
            "sales.customer.read",
            "sales.customer.write",
            "sales.order.read",
            "sales.order.write",
            "sales.order.approve",
            "sales.dispatch.read",
            "sales.dispatch.write",
            "sales.trip.read",
            "sales.invoice.read",
            "production.stock.read",
            "fleet.vehicle.read",
            "compliance.ewb.read",
            "compliance.ewb.write",
        ),
    ),
    "stores_incharge": RoleSpec(
        "Stores In-charge",
        "stores",
        (
            "stores.indent.read",
            "stores.indent.create",
            "stores.indent.approve",
            "stores.expense.read",
            "stores.expense.upload",
            "production.stock.read",
            "ai.extraction.review",
        ),
    ),
    "weighbridge_operator": RoleSpec(
        "Weighbridge Operator",
        "production",
        (
            "production.run.create",
            "production.run.read",
            "production.stock.read",
            "sales.dispatch.read",
            "sales.trip.read",
        ),
    ),
    "driver": RoleSpec(
        "Driver",
        "fleet",
        ("field.trip.read", "fleet.fuel.create"),
    ),
}


def role_grants(
    modules: Iterable[str], permission_modules: dict[str, str]
) -> tuple[dict[str, tuple[str, ...]], list[str]]:
    """The roles a tenant with ``modules`` switched on gets, and the keys each grants there.

    Returns ``(granted, skipped)``. A role whose vertical is off is not created
    at all, and a role that survives grants no key from a module the tenant
    never bought — an accounts clerk at a crusher-only client has no business
    holding fleet.vehicle.read.
    """
    enabled = set(modules)
    granted: dict[str, tuple[str, ...]] = {}
    skipped: list[str] = []
    for key, role in ROLES.items():
        if role.requires_module is not None and role.requires_module not in enabled:
            skipped.append(key)
            continue
        keys = tuple(
            p for p in role.permissions if permission_modules[p] == "core" or permission_modules[p] in enabled
        )
        if not keys:
            skipped.append(key)
            continue
        granted[key] = keys
    return granted, skipped
