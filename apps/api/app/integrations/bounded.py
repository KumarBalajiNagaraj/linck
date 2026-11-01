"""Reading a response body whose size somebody else decides.

A news feed or a model host can send any number of bytes. Reading the body
with `response.content` holds all of it in memory before anything can say no,
so the body is streamed and the read stops at the limit. The limit counts
decoded bytes, so a small gzip that inflates to something huge is refused too.
"""

from __future__ import annotations

import httpx


class TooLarge(Exception):
    """The body went past the limit. The message is safe to log and store."""


async def read_bounded(response: httpx.Response, limit: int) -> bytes:
    """The whole body of a streamed response, or `TooLarge` once it passes `limit` bytes."""
    declared = response.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise TooLarge(f"{int(declared):,} bytes declared, more than the {limit:,} allowed")
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk)
        if len(body) > limit:
            raise TooLarge(f"more than the {limit:,} bytes allowed")
    return bytes(body)
