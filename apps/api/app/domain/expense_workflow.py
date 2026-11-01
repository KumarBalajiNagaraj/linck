"""THE EXPENSE BILL APPROVAL CHAIN, enforced where the bill is stored.

A port of packages/domain/src/expense-workflow.ts, kept line-for-line close so
the two can be read side by side; tests/test_expense_workflow.py mirrors its
test file. The screens use the TypeScript to decide what to offer; this copy
decides what is allowed.

    submitted ──validate──▶ validated ──approve──▶ approved ──pass──▶ passed ──pay──▶ paid
    (fleet or stores desk)   (fleet manager)        (director)         (accounts)       (accounts, UTR)

plus: reject (with a reason, at any unpaid step), send back one step (with a
note), delete (only before anyone has signed, with a reason; the bill stays on
record as deleted), and restore a deleted bill.

  - Each move needs exactly one permission, at the bill's site.
  - Every move is appended to the bill's history, which is never edited.
  - FOUR EYES: nobody should sign the same bill twice, and the person who
    raised it counts as having signed. A second signature goes through only
    with a written note and is marked as an exception the director sees; a
    tenant on `segregation_enforcement = 'hard_block'` refuses it outright. A
    batch never carries an exception: such bills are left out, and it says
    why. (Accounts passing and then paying is one job, not an exception.)
  - Money is counted in whole paise.

Two deliberate differences from the TypeScript, both about inputs it trusts
its callers for: "today" for the payment date is the tenant's business date
(the TS compares against the UTC date, which is the wrong day for five and a
half hours of every IST day), and a payment date that is not a real calendar
date is refused with the same code as a future one.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal

BillStatus = Literal["submitted", "validated", "approved", "passed", "paid", "rejected", "deleted"]
BillAction = Literal["validate", "approve", "pass", "pay", "reject", "send_back", "delete", "restore"]
PaymentMode = Literal["NEFT", "RTGS", "IMPS", "UPI", "Cheque", "Cash"]

STATUSES: tuple[str, ...] = ("submitted", "validated", "approved", "passed", "paid", "rejected", "deleted")
ACTIONS: tuple[str, ...] = ("validate", "approve", "pass", "pay", "reject", "send_back", "delete", "restore")
PAYMENT_MODES: tuple[str, ...] = ("NEFT", "RTGS", "IMPS", "UPI", "Cheque", "Cash")

#: A problem as the web words it: `{"code": ..., **values}` (WorkflowProblem).
Problem = dict[str, Any]

#: The problems that mean "not yours to do" rather than "not now" or "not like that".
PERMISSION_PROBLEMS = frozenset({"needs-permission", "only-step-owner", "only-desk-deletes"})


@dataclass(frozen=True)
class BillEvent:
    action: str
    from_status: str
    to_status: str
    #: Who acted — compared by id, shown by name.
    by_id: str
    by: str
    at: datetime
    note: str | None
    #: A second signature by someone who already signed this bill.
    exception: bool


@dataclass(frozen=True)
class PaymentRecord:
    utr: str
    paid_on: str
    mode: str


@dataclass(frozen=True)
class WorkflowBill:
    """What the workflow needs of a bill."""

    id: str
    status: str
    desk: str
    site_id: str
    amount: Decimal
    litres: Decimal | None
    #: Who raised it: a driver on WhatsApp, or the person who uploaded it.
    submitted_by_id: str | None
    submitted_by: str
    history: tuple[BillEvent, ...] = ()
    payment: PaymentRecord | None = None


@dataclass(frozen=True)
class Actor:
    id: str
    name: str
    #: Whether this person holds `permission` at `site_id`.
    can: Callable[[str, str], bool]


@dataclass(frozen=True)
class ActionOption:
    action: str
    #: False, with the problem, when the person cannot take it at all.
    allowed: bool
    problem: Problem | None
    #: A note is required: rejecting, deleting, sending back, or any exception.
    needs_note: bool
    #: Taking it would be a second signature by the same person.
    exception: bool


class WorkflowError(Exception):
    def __init__(self, problem: Problem) -> None:
        # The message is for logs; people read the problem, worded by the screen.
        super().__init__(f"{problem['code']} {problem}")
        self.problem = problem


@dataclass(frozen=True)
class _Step:
    action: str
    to: str
    permission: Callable[[WorkflowBill], str]


#: The one signing step each status waits on, and the key it needs.
STEP: dict[str, _Step] = {
    "submitted": _Step("validate", "validated", lambda b: f"{b.desk}.expense.validate"),
    "validated": _Step("approve", "approved", lambda b: "finance.expense.approve"),
    "approved": _Step("pass", "passed", lambda b: "finance.expense.pass"),
    "passed": _Step("pay", "paid", lambda b: "finance.expense.pay"),
}

PREVIOUS: dict[str, str] = {"validated": "submitted", "approved": "validated", "passed": "approved"}

#: The signing moves: the ones the four-eyes rule counts.
SIGNING: tuple[str, ...] = ("validate", "approve", "pass", "pay")


def signers_of(bill: WorkflowBill) -> list[tuple[str, str]]:
    """Who has signed the bill as it stands, as `(id, action)`: its submitter,
    then each signing move still in force. Sending back one step undoes the
    last signature; restoring a deleted bill starts it afresh. The history
    keeps every one regardless."""
    chain: list[tuple[str, str]] = []
    for e in bill.history:
        if e.action in SIGNING:
            chain.append((e.by_id, e.action))
        elif e.action == "send_back":
            if chain:
                chain.pop()
        elif e.action == "restore":
            chain.clear()
    submitter = [(bill.submitted_by_id, "submit")] if bill.submitted_by_id else []
    return submitter + chain


def _would_repeat(bill: WorkflowBill, actor: Actor, action: str) -> bool:
    signers = signers_of(bill)
    # Accounts passes and pays as one job: paying after passing is not a second opinion being skipped.
    if action == "pay":
        return any(sid == actor.id and act != "pass" for sid, act in signers)
    return any(sid == actor.id for sid, _ in signers)


def available_actions(bill: WorkflowBill, actor: Actor) -> list[ActionOption]:
    opts: list[ActionOption] = []

    def add(action: str, allowed: bool, problem: Problem, needs_note: bool, exception: bool = False) -> None:
        opts.append(
            ActionOption(action, allowed, None if allowed else problem, needs_note or exception, exception)
        )

    step = STEP.get(bill.status)
    if step:
        permission = step.permission(bill)
        may = actor.can(permission, bill.site_id)
        repeat = may and _would_repeat(bill, actor, step.action)
        add(step.action, may, {"code": "needs-permission", "permission": permission}, False, repeat)
        add("reject", may, {"code": "only-step-owner", "step": step.action}, True)
        if bill.status in PREVIOUS:
            add("send_back", may, {"code": "needs-permission", "permission": permission}, True)
    if bill.status == "submitted":
        may_delete = actor.can(f"{bill.desk}.expense.upload", bill.site_id) or actor.can(
            f"{bill.desk}.expense.validate", bill.site_id
        )
        add("delete", may_delete, {"code": "only-desk-deletes"}, True)
    if bill.status == "deleted":
        permission = f"{bill.desk}.expense.validate"
        add(
            "restore",
            actor.can(permission, bill.site_id),
            {"code": "needs-permission", "permission": permission},
            False,
        )
    return opts


@dataclass(frozen=True)
class ActionInput:
    note: str | None = None
    payment: PaymentRecord | None = None
    #: UTRs already used on other payments; a bank reference is never reused.
    used_utrs: frozenset[str] = field(default_factory=frozenset)


UTR = re.compile(r"^[A-Z0-9]{6,22}$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _is_calendar_date(text: str) -> bool:
    try:
        date.fromisoformat(text)
    except ValueError:
        return False
    return True


def apply_action(
    bill: WorkflowBill,
    action: str,
    actor: Actor,
    at: datetime,
    input: ActionInput | None = None,
    *,
    today: date | None = None,
    hard_block: bool = False,
) -> WorkflowBill:
    """The bill after `action`, or a WorkflowError saying why it cannot be taken.

    `today` is the business date payments may not be dated after; it defaults
    to `at`'s own date, as the TypeScript does. `hard_block` refuses a second
    signature even with a note.
    """
    input = input or ActionInput()
    option = next((o for o in available_actions(bill, actor) if o.action == action), None)
    if option is None:
        raise WorkflowError({"code": "wrong-step", "status": bill.status, "action": action})
    if not option.allowed:
        raise WorkflowError(option.problem or {"code": "wrong-step", "status": bill.status, "action": action})
    if option.exception and hard_block:
        raise WorkflowError({"code": "second-signature"})
    note = (input.note or "").strip() or None
    if option.needs_note and not note:
        raise WorkflowError(
            {"code": "second-signature"} if option.exception else {"code": "needs-reason", "action": action}
        )

    payment = bill.payment
    if action in ("validate", "approve", "pass"):
        to = STEP[bill.status].to
    elif action == "pay":
        p = input.payment
        if p is None:
            raise WorkflowError({"code": "needs-payment"})
        utr = p.utr.strip().upper()
        if p.mode != "Cash" and not UTR.match(utr):
            raise WorkflowError({"code": "bad-utr"})
        if p.mode != "Cash" and utr in input.used_utrs:
            raise WorkflowError({"code": "utr-used", "utr": utr})
        day = (today or at.date()).isoformat()
        if not ISO_DATE.match(p.paid_on) or not _is_calendar_date(p.paid_on) or p.paid_on > day:
            raise WorkflowError({"code": "future-payment-date"})
        payment = replace(p, utr=utr)
        to = "paid"
    elif action == "reject":
        to = "rejected"
    elif action == "send_back":
        to = PREVIOUS[bill.status]
    elif action == "delete":
        to = "deleted"
    else:  # restore
        to = "submitted"
    event = BillEvent(action, bill.status, to, actor.id, actor.name, at, note, option.exception)
    return replace(bill, status=to, payment=payment, history=(*bill.history, event))


@dataclass(frozen=True)
class BatchPlan:
    action: str
    eligible: list[WorkflowBill]
    skipped: list[tuple[WorkflowBill, Problem]]
    #: Whole paise.
    total_paise: int
    litres: Decimal


def _paise(amount: Decimal) -> int:
    return int((amount * 100).to_integral_value(rounding=ROUND_HALF_UP))


def plan_batch(bills: Sequence[WorkflowBill], action: str, actor: Actor) -> BatchPlan:
    """What a bulk action would do, before it is done. Only bills the person may
    take the action on WITHOUT an exception go in; everything else is listed
    with its reason, so "approve all" never quietly includes a bill someone
    signed twice, and never quietly drops one either."""
    eligible: list[WorkflowBill] = []
    skipped: list[tuple[WorkflowBill, Problem]] = []
    for bill in bills:
        o = next((x for x in available_actions(bill, actor) if x.action == action), None)
        if o is None:
            skipped.append((bill, {"code": "wrong-step", "status": bill.status, "action": action}))
        elif not o.allowed:
            skipped.append(
                (bill, o.problem or {"code": "wrong-step", "status": bill.status, "action": action})
            )
        elif o.exception:
            skipped.append((bill, {"code": "batch-second-signature"}))
        else:
            eligible.append(bill)
    centilitres = sum(
        ((b.litres or Decimal(0)) * 100).to_integral_value(rounding=ROUND_HALF_UP) for b in eligible
    )
    return BatchPlan(
        action=action,
        eligible=eligible,
        skipped=skipped,
        total_paise=sum(_paise(b.amount) for b in eligible),
        litres=Decimal(centilitres) / 100,
    )


def exceptions_in(bills: Sequence[WorkflowBill]) -> list[tuple[WorkflowBill, BillEvent]]:
    """Every exception in the history of these bills: the director's list of second signatures."""
    return [(bill, event) for bill in bills for event in bill.history if event.exception]
