"""The approval chain's rules, mirroring packages/domain/src/expense-workflow.test.ts.

Each TypeScript test has a counterpart here with the same name in snake case,
so a rule that changes on one side and not the other shows up as a test that
exists on only one. The last block covers what only the server adds.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal

from app.domain.expense_workflow import (
    ActionInput,
    Actor,
    PaymentRecord,
    WorkflowBill,
    WorkflowError,
    apply_action,
    available_actions,
    exceptions_in,
    plan_batch,
    signers_of,
)

KRP = "site-krp"
T = datetime(2026, 8, 8, 9, 0, tzinfo=UTC)
PAY = PaymentRecord(utr="hdfcn52026080812345", paid_on="2026-08-08", mode="NEFT")


def person(id: str, keys: list[str], sites: list[str] | None = None) -> Actor:
    sites = sites if sites is not None else [KRP]
    return Actor(id=id, name=id, can=lambda permission, site_id: permission in keys and site_id in sites)


fleet = person("fleet", ["fleet.expense.upload", "fleet.expense.validate"])
director = person("director", ["finance.expense.approve"])
accounts = person("accounts", ["finance.expense.pass", "finance.expense.pay"])
driver = person("driver:drv-001", [])


def bill(**over: object) -> WorkflowBill:
    base = WorkflowBill(
        id="b1",
        status="submitted",
        desk="fleet",
        site_id=KRP,
        amount=Decimal("41277.60"),
        litres=Decimal("432"),
        submitted_by_id="driver:drv-001",
        submitted_by="Murugan S",
        history=(),
        payment=None,
    )
    return replace(base, **over)  # type: ignore[arg-type]


def problem_of(move) -> dict | None:  # type: ignore[no-untyped-def]
    """The problem a move was refused for, or None when it went through."""
    try:
        move()
    except WorkflowError as e:
        return e.problem
    return None


def option(b: WorkflowBill, actor: Actor, action: str):  # type: ignore[no-untyped-def]
    return next(o for o in available_actions(b, actor) if o.action == action)


# --------------------------------------------------------------- the chain


def test_goes_validate_approve_pass_pay_each_step_logged() -> None:
    b = bill()
    b = apply_action(b, "validate", fleet, T)
    b = apply_action(b, "approve", director, T)
    b = apply_action(b, "pass", accounts, T)
    b = apply_action(b, "pay", accounts, T, ActionInput(payment=PAY))
    assert b.status == "paid"
    assert b.payment == replace(PAY, utr="HDFCN52026080812345")
    assert [f"{e.action}:{e.from_status}→{e.to_status}:{e.by}" for e in b.history] == [
        "validate:submitted→validated:fleet",
        "approve:validated→approved:director",
        "pass:approved→passed:accounts",
        "pay:passed→paid:accounts",
    ]
    assert not any(e.exception for e in b.history)


def test_lets_each_step_be_taken_only_by_whoever_holds_its_key_at_the_bills_site() -> None:
    assert problem_of(lambda: apply_action(bill(), "validate", director, T)) == {
        "code": "needs-permission",
        "permission": "fleet.expense.validate",
    }
    assert problem_of(lambda: apply_action(bill(status="validated"), "approve", fleet, T)) == {
        "code": "needs-permission",
        "permission": "finance.expense.approve",
    }
    elsewhere = person("fleet-tvl", ["fleet.expense.validate"], ["site-tvl"])
    assert problem_of(lambda: apply_action(bill(), "validate", elsewhere, T)) is not None
    assert problem_of(lambda: apply_action(bill(), "approve", director, T)) == {
        "code": "wrong-step",
        "status": "submitted",
        "action": "approve",
    }


def test_routes_a_stores_bill_to_the_stores_key() -> None:
    stores_bill = bill(desk="stores")
    assert problem_of(lambda: apply_action(stores_bill, "validate", fleet, T)) == {
        "code": "needs-permission",
        "permission": "stores.expense.validate",
    }
    wsp = person("fleet", ["stores.expense.validate"])
    assert apply_action(stores_bill, "validate", wsp, T).status == "validated"


# ---------------------------------------------------------------- four eyes


def test_lets_the_uploader_validate_their_own_bill_only_with_a_note_marked_as_an_exception() -> None:
    own = bill(submitted_by_id="fleet", submitted_by="fleet")
    o = option(own, fleet, "validate")
    assert (o.allowed, o.exception, o.needs_note) == (True, True, True)
    assert problem_of(lambda: apply_action(own, "validate", fleet, T)) == {"code": "second-signature"}
    done = apply_action(
        own, "validate", fleet, T, ActionInput(note="Driver on leave; checked the slip myself")
    )
    assert done.history[0].exception is True
    assert done.history[0].note == "Driver on leave; checked the slip myself"
    assert len(exceptions_in([done])) == 1


def test_does_not_count_accounts_passing_then_paying_as_a_second_signature() -> None:
    b = apply_action(bill(), "validate", fleet, T)
    b = apply_action(b, "approve", director, T)
    b = apply_action(b, "pass", accounts, T)
    assert option(b, accounts, "pay").exception is False


def test_forgets_an_undone_signature_sent_back_the_bill_can_be_signed_by_the_same_person_again() -> None:
    b = apply_action(bill(), "validate", fleet, T)
    b = apply_action(b, "send_back", director, T, ActionInput(note="Bill number is the bunk's phone number"))
    assert b.status == "submitted"
    assert [sid for sid, _ in signers_of(b)] == ["driver:drv-001"]
    assert option(b, fleet, "validate").exception is False


# ------------------------------------------------------ reject, delete, restore


def test_needs_a_reason_to_reject_delete_or_send_back() -> None:
    assert problem_of(lambda: apply_action(bill(), "reject", fleet, T)) == {
        "code": "needs-reason",
        "action": "reject",
    }
    assert problem_of(lambda: apply_action(bill(), "delete", fleet, T, ActionInput(note=" "))) == {
        "code": "needs-reason",
        "action": "delete",
    }
    assert (
        apply_action(bill(), "reject", fleet, T, ActionInput(note="Slip is for a car")).status == "rejected"
    )


def test_deletes_only_before_anyone_has_signed_and_keeps_the_bill_on_record() -> None:
    deleted = apply_action(bill(), "delete", fleet, T, ActionInput(note="Posted twice"))
    assert deleted.status == "deleted"
    validated = apply_action(bill(), "validate", fleet, T)
    assert not any(o.action == "delete" for o in available_actions(validated, fleet))
    assert apply_action(deleted, "restore", fleet, T).status == "submitted"


def test_lets_the_steps_owner_reject_at_a_later_step_too() -> None:
    b = apply_action(apply_action(bill(), "validate", fleet, T), "approve", director, T)
    assert problem_of(lambda: apply_action(b, "reject", director, T, ActionInput(note="x"))) is not None
    assert (
        apply_action(b, "reject", accounts, T, ActionInput(note="Duplicate of BK/48213")).status == "rejected"
    )


# ------------------------------------------------------------------ payment


def passed() -> WorkflowBill:
    return apply_action(
        apply_action(apply_action(bill(), "validate", fleet, T), "approve", director, T), "pass", accounts, T
    )


def test_needs_a_utr_the_bank_would_show_and_never_one_already_used() -> None:
    assert problem_of(lambda: apply_action(passed(), "pay", accounts, T)) == {"code": "needs-payment"}
    assert problem_of(
        lambda: apply_action(passed(), "pay", accounts, T, ActionInput(payment=replace(PAY, utr="12")))
    ) == {"code": "bad-utr"}
    assert problem_of(
        lambda: apply_action(
            passed(),
            "pay",
            accounts,
            T,
            ActionInput(payment=PAY, used_utrs=frozenset({"HDFCN52026080812345"})),
        )
    ) == {"code": "utr-used", "utr": "HDFCN52026080812345"}
    assert problem_of(
        lambda: apply_action(
            passed(), "pay", accounts, T, ActionInput(payment=replace(PAY, paid_on="2026-08-09"))
        )
    ) == {"code": "future-payment-date"}
    cash = PaymentRecord(utr="", paid_on="2026-08-08", mode="Cash")
    assert apply_action(passed(), "pay", accounts, T, ActionInput(payment=cash)).status == "paid"


# ------------------------------------------------------------------ batches


def test_approves_all_the_clean_ones_in_one_go_and_says_why_the_rest_were_left_out() -> None:
    both_sites = person("fleet", ["fleet.expense.validate"], [KRP, "site-tvl"])

    def validated(id: str, amount: str, **over: object) -> WorkflowBill:
        return apply_action(bill(id=id, amount=Decimal(amount), **over), "validate", both_sites, T)

    bills = [
        validated("a", "100.10"),
        validated("b", "200.20"),
        bill(id="c"),  # not validated yet
        validated("d", "50.00", site_id="site-tvl"),
    ]
    plan = plan_batch(bills, "approve", director)
    assert [b.id for b in plan.eligible] == ["a", "b"]
    assert plan.total_paise == 30030
    assert [(b.id, p) for b, p in plan.skipped] == [
        ("c", {"code": "wrong-step", "status": "submitted", "action": "approve"}),
        ("d", {"code": "needs-permission", "permission": "finance.expense.approve"}),
    ]


def test_never_slips_a_second_signature_into_a_batch() -> None:
    own = bill(id="own", submitted_by_id="fleet")
    assert plan_batch([own], "validate", fleet).skipped[0][1] == {"code": "batch-second-signature"}


def test_keeps_someone_with_no_key_from_anything() -> None:
    assert all(not o.allowed for o in available_actions(bill(), driver))


# ------------------------------------------------------- what the server adds


def test_a_hard_block_tenant_refuses_a_second_signature_even_with_a_note() -> None:
    own = bill(submitted_by_id="fleet")
    assert problem_of(
        lambda: apply_action(own, "validate", fleet, T, ActionInput(note="I checked it"), hard_block=True)
    ) == {"code": "second-signature"}
    # A clean signature is untouched by the switch.
    assert apply_action(bill(), "validate", fleet, T, hard_block=True).status == "validated"


def test_the_payment_date_is_checked_against_the_business_date_not_the_utc_one() -> None:
    # 01:00 IST on 9 August is still 8 August in UTC. Paying "today" is fine.
    late = datetime(2026, 8, 8, 19, 30, tzinfo=UTC)
    paid = apply_action(
        passed(),
        "pay",
        accounts,
        late,
        ActionInput(payment=replace(PAY, paid_on="2026-08-09")),
        today=date(2026, 8, 9),
    )
    assert paid.status == "paid"


def test_a_payment_date_that_is_not_a_date_is_refused() -> None:
    assert problem_of(
        lambda: apply_action(
            passed(), "pay", accounts, T, ActionInput(payment=replace(PAY, paid_on="2026-02-30"))
        )
    ) == {"code": "future-payment-date"}


def test_batch_totals_count_whole_paise_and_centilitres() -> None:
    a = apply_action(
        bill(id="a", amount=Decimal("41277.60"), litres=Decimal("120.455")), "validate", fleet, T
    )
    b = apply_action(bill(id="b", amount=Decimal("0.05"), litres=None), "validate", fleet, T)
    plan = plan_batch([a, b], "approve", director)
    assert plan.total_paise == 4127765
    assert plan.litres == Decimal("120.46")
