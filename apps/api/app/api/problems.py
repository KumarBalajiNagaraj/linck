"""Refusals as codes the web words, never as English.

    {"detail": {"problem": {"code": "needs-permission", "permission": "fleet.expense.validate"}}}

The workflow codes are expense-workflow.ts's WorkflowProblem, with the same
payload fields, so the screen that already words them needs nothing new. 403
is "not yours to do", 409 is "not now, or not like that", 404 is "not here".
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

from app.domain.expense_workflow import PERMISSION_PROBLEMS


def refuse(problem: dict[str, Any]) -> HTTPException:
    code = status.HTTP_403_FORBIDDEN if problem["code"] in PERMISSION_PROBLEMS else status.HTTP_409_CONFLICT
    return HTTPException(status_code=code, detail={"problem": problem})


def needs_permission(permission: str) -> HTTPException:
    return refuse({"code": "needs-permission", "permission": permission})


def gone(code: str = "not-found") -> HTTPException:
    """The row is not there, or is another tenant's: the two look the same on purpose."""
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"problem": {"code": code}})


def invalid(field: str, reason: str) -> HTTPException:
    """A value that has the right shape but cannot be stored."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail={"problem": {"code": "invalid", "field": field, "reason": reason}},
    )
