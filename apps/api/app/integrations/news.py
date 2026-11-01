"""Google News RSS: the headlines behind the industry digest (LIN-10).

Free, and needs no key: one search feed per query, from the English edition
for India (`hl=en-IN&gl=IN&ceid=IN:en`), asked for the last 14 days only.

Every feed is untrusted input from the open internet, so:

- it is fetched with a timeout and a size cap, and a feed that fails is
  skipped and named rather than taking the others down with it;
- it is parsed with defusedxml with DTDs forbidden: no entity expansion (the
  "billion laughs"), no external entities, no network fetches by the parser;
- every field is cleaned before anything else sees it. Text is unescaped,
  stripped of tags and control characters, and capped. A link must be plain
  http(s) with a host and no credentials. An item without a title, a usable
  link or a readable date is dropped.

Items older than 14 days are dropped, and so is the same story found twice:
the same link from two queries, or the same title from two papers printing
one wire report.

The parsing does no I/O, so it is tested on bytes; `fetch_headlines` makes
the requests, on the client it is handed.
"""

from __future__ import annotations

import asyncio
import html
import logging
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit
from xml.etree.ElementTree import Element

import httpx
from defusedxml import DefusedXmlException
from defusedxml.ElementTree import ParseError, fromstring

from app.integrations.bounded import TooLarge, read_bounded

log = logging.getLogger("linck.news")

GOOGLE_NEWS_RSS = "https://news.google.com/rss/search"
# English results for India: the edition the owner reads.
EDITION = {"hl": "en-IN", "gl": "IN", "ceid": "IN:en"}

MAX_AGE = timedelta(days=14)
# A date a little ahead is a clock or a timezone; much more is a broken feed.
FUTURE_SLACK = timedelta(days=1)
# A full Google News search feed (100 items) is about 150 KB.
MAX_FEED_BYTES = 2_000_000
FEED_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
# The newest items of each feed, so one busy topic cannot crowd out the rest.
PER_FEED = 15
MAX_QUERIES = 20
CONCURRENCY = 4
MAX_TITLE = 300
MAX_SOURCE = 100
MAX_LINK = 2048
HEADERS = {
    "User-Agent": "Linck/0.1 (industry news)",
    "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.1",
}


class NewsError(RuntimeError):
    """One feed could not be read. The message is safe to log and to store."""


class NewsUnavailable(NewsError):
    """No feed gave a usable headline."""


@dataclass(frozen=True)
class Headline:
    title: str
    source: str
    published_at: datetime
    link: str


@dataclass(frozen=True)
class NewsResult:
    #: Newest first, each story once.
    headlines: list[Headline]
    #: The queries whose feed could not be read.
    failed: list[str]


# ---------------------------------------------------------------------------
# Cleaning what a feed says
# ---------------------------------------------------------------------------

# Only what looks like an HTML tag, so "price < 500" survives.
_TAG = re.compile(r"</?[A-Za-z][^<>]{0,200}>")
# C0 controls other than whitespace, DEL, and the bidi overrides that make
# text display in an order other than the one it is stored in.
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]")
_SPACE = re.compile(r"\s+")


def clean_text(raw: object, limit: int | None = None) -> str:
    """Untrusted text as one plain line: unescaped, no tags or control characters, capped."""
    if not isinstance(raw, str) or not raw:
        return ""
    text = html.unescape(raw)
    text = _TAG.sub(" ", text)
    text = _CONTROL.sub("", text)
    text = _SPACE.sub(" ", text).strip()
    return text if limit is None else cap(text, limit)


def cap(text: str, limit: int) -> str:
    """At most `limit` characters, ending in an ellipsis when cut."""
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def safe_link(raw: object) -> str | None:
    """The link if it is plain http(s) with a host and no credentials, else None.

    Anything else — `javascript:`, `data:`, a relative path, a link with a
    user name in it — is never shown as something a person can tap.
    """
    if not isinstance(raw, str):
        return None
    link = raw.strip()
    if not link or len(link) > MAX_LINK or not link.isprintable() or " " in link:
        return None
    try:
        parts = urlsplit(link)
        host = parts.hostname
        credentials = parts.username is not None or parts.password is not None
        _ = parts.port  # a malformed port raises here
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not host or credentials:
        return None
    return link


def parse_date(raw: object) -> datetime | None:
    """An RSS `pubDate` (RFC 822) as an aware UTC datetime, or None."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        when = parsedate_to_datetime(raw.strip())
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return when.astimezone(UTC)


def parse_feed(body: bytes, *, now: datetime) -> list[Headline]:
    """Every usable item in an RSS 2.0 feed, in feed order. `NewsError` if it is not one."""
    try:
        root = fromstring(body, forbid_dtd=True)
    except (ParseError, DefusedXmlException) as exc:
        raise NewsError(f"not readable as XML ({type(exc).__name__})") from exc
    if root.tag != "rss":
        raise NewsError("not an RSS feed")
    headlines = []
    for item in root.iterfind("channel/item"):
        headline = _headline(item, now=now)
        if headline is not None:
            headlines.append(headline)
    return headlines


def _headline(item: Element, *, now: datetime) -> Headline | None:
    link = safe_link(item.findtext("link"))
    published = parse_date(item.findtext("pubDate"))
    source = clean_text(item.findtext("source"), MAX_SOURCE)
    title = clean_text(item.findtext("title"))
    # Google News ends each title with the paper's name, which is the source already.
    if source and title.endswith(f" - {source}"):
        title = title[: -len(source) - 3].rstrip()
    if not title or link is None or published is None:
        return None
    if not now - MAX_AGE <= published <= now + FUTURE_SLACK:
        return None
    return Headline(title=cap(title, MAX_TITLE), source=source, published_at=published, link=link)


_NOT_WORD = re.compile(r"[^\w]+")


def _story(title: str) -> str:
    """A title reduced to its words, so two papers' copies of one wire story match."""
    return " ".join(_NOT_WORD.sub(" ", title.casefold()).split())


def dedupe(headlines: Iterable[Headline]) -> list[Headline]:
    """Each story once, the first copy kept: by link, and by title."""
    links: set[str] = set()
    stories: set[str] = set()
    kept = []
    for h in headlines:
        story = _story(h.title)
        if h.link in links or story in stories:
            continue
        links.add(h.link)
        stories.add(story)
        kept.append(h)
    return kept


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------


def feed_params(query: str) -> dict[str, str]:
    """The search, limited to the window anything older is dropped from anyway."""
    q = query if "when:" in query else f"{query} when:{MAX_AGE.days}d"
    return {"q": q, **EDITION}


async def fetch_feed(http: httpx.AsyncClient, query: str, *, now: datetime) -> list[Headline]:
    """One query's newest headlines. `NewsError` if the feed cannot be read."""
    try:
        async with http.stream(
            "GET",
            GOOGLE_NEWS_RSS,
            params=feed_params(query),
            headers=HEADERS,
            timeout=FEED_TIMEOUT,
            follow_redirects=True,
        ) as response:
            if response.status_code != 200:
                raise NewsError(f"answered {response.status_code}")
            body = await read_bounded(response, MAX_FEED_BYTES)
    except TooLarge as exc:
        raise NewsError(f"too large: {exc}") from exc
    except httpx.TimeoutException as exc:
        raise NewsError("timed out") from exc
    except httpx.HTTPError as exc:
        raise NewsError(f"could not be fetched ({type(exc).__name__})") from exc
    headlines = parse_feed(body, now=now)
    headlines.sort(key=lambda h: h.published_at, reverse=True)
    return headlines[:PER_FEED]


async def fetch_headlines(
    http: httpx.AsyncClient, queries: Sequence[str], *, now: datetime | None = None
) -> NewsResult:
    """Every query's feed, a few at a time. `NewsUnavailable` only when none gives a headline."""
    now = now or datetime.now(UTC)
    wanted = list(dict.fromkeys(q.strip() for q in queries if q.strip()))
    if len(wanted) > MAX_QUERIES:
        log.warning("%d news queries configured; reading the first %d", len(wanted), MAX_QUERIES)
        wanted = wanted[:MAX_QUERIES]
    if not wanted:
        raise NewsUnavailable("no news queries are configured")

    gate = asyncio.Semaphore(CONCURRENCY)

    async def one(query: str) -> list[Headline] | NewsError:
        async with gate:
            try:
                return await fetch_feed(http, query, now=now)
            except NewsError as exc:
                log.warning("news feed %r could not be read: %s", query, exc)
                return exc

    results = await asyncio.gather(*(one(q) for q in wanted))
    failed = [q for q, r in zip(wanted, results, strict=True) if isinstance(r, NewsError)]
    found = [h for r in results if not isinstance(r, NewsError) for h in r]
    headlines = sorted(dedupe(found), key=lambda h: h.published_at, reverse=True)
    if not headlines:
        raise NewsUnavailable(
            f"none of the {len(wanted)} news feeds could be read"
            if len(failed) == len(wanted)
            else "the news feeds had no headlines from the last 14 days"
        )
    return NewsResult(headlines=headlines, failed=failed)
