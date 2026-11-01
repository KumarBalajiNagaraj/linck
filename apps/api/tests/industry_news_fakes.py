"""Fake Google News feeds and a fake model host, for the industry news tests.

Nothing here touches the network: every test hands `FakeNet.transport()` to
httpx, which answers from what the test set up. The headlines are made up for
the tests and are never shown to anyone.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from typing import Any
from xml.sax.saxutils import escape

import httpx

NOW = datetime(2026, 11, 1, 6, 30, tzinfo=UTC)
MODEL_URL = "https://models.example/v1"
MODEL = "example/free-model:free"
KEY = "sk-test-key-0123456789abcdef"
QUERIES = ["Tamil Nadu construction", "Chennai real estate"]

# Made-up headlines, with how relevant the keyword ranking should find them.
MSAND = "M-sand prices rise as quarry strike enters third day"  # the most relevant
TENDERS = "TN highways department floats tenders for four bypass roads"
METRO = "Chennai Metro phase 2 tunnelling picks up pace"
CEMENT = "Cement makers raise prices in south India"
FLATS = "Chennai apartment launches up this quarter"
RAIN = "Northeast monsoon to bring heavy rain to north TN districts"
FILM = "Film star opens a new restaurant in Coimbatore"  # not relevant at all


def article(title: str) -> str:
    """The link the fake feed gives a headline: a Google News article URL, never a real one."""
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return f"https://news.google.com/rss/articles/{slug}?oc=5"


def news_item(
    title: str,
    source: str = "The Hindu",
    *,
    published: datetime | str | None = None,
    link: str | None = None,
) -> str:
    """One RSS <item>, shaped as Google News sends it: the title ends with " - <paper>"."""
    when = published if published is not None else NOW - timedelta(hours=6)
    pub = format_datetime(when) if isinstance(when, datetime) else when
    return (
        "<item>"
        f"<title>{escape(title)} - {escape(source)}</title>"
        f"<link>{escape(link if link is not None else article(title))}</link>"
        f"<pubDate>{escape(pub)}</pubDate>"
        f'<source url="https://paper.example">{escape(source)}</source>'
        "</item>"
    )


def rss(*items: str) -> bytes:
    return (
        '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Google News</title>'
        + "".join(items)
        + "</channel></rss>"
    ).encode()


def two_feeds(now: datetime = NOW) -> dict[str, bytes | int | Exception]:
    """Seven stories over the two test queries, one of them found by both.

    Numbered newest first, as the model sees them: FILM, MSAND, TENDERS,
    METRO, CEMENT, FLATS, RAIN.
    """

    def ago(hours: int) -> datetime:
        return now - timedelta(hours=hours)

    return {
        QUERIES[0]: rss(
            news_item(MSAND, "DT Next", published=ago(2)),
            news_item(TENDERS, "The Times of India", published=ago(5)),
            news_item(METRO, published=ago(9)),
            news_item(CEMENT, "BusinessLine", published=ago(20)),
        ),
        QUERIES[1]: rss(
            news_item(METRO, published=ago(9)),
            news_item(FLATS, "The Economic Times", published=ago(30)),
            news_item(RAIN, "The New Indian Express", published=ago(40)),
            news_item(FILM, "Cinema Express", published=ago(1)),
        ),
    }


def line(n: int, **over: Any) -> dict[str, Any]:
    """One item as the model is asked to write it, for headline number `n`."""
    item: dict[str, Any] = {
        "n": n,
        "en": f"Plain line about headline {n}.",
        "ta": f"செய்தி {n} பற்றி ஒரு எளிய வரி.",
        "whyEn": f"Why headline {n} matters to us.",
        "whyTa": f"செய்தி {n} நமக்கு ஏன் முக்கியம்.",
    }
    item.update(over)
    return item


def model_reply(
    content: list[dict[str, Any]] | str, *, finish: str = "stop", model: str = MODEL
) -> httpx.Response:
    """A chat-completions answer whose message is `content`: items as JSON, or raw text."""
    text = content if isinstance(content, str) else json.dumps({"items": content}, ensure_ascii=False)
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "model": model,
            "choices": [
                {"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": finish}
            ],
        },
    )


@dataclass
class FakeNet:
    """news.google.com and a model host, answering from what a test sets.

    `feeds` maps a query to the feed's bytes, an HTTP status to answer with,
    or an exception to raise. `replies` are the model's answers, in order,
    given by whichever host `model_host` names.
    """

    feeds: dict[str, bytes | int | Exception] = field(default_factory=two_feeds)
    replies: list[httpx.Response | Exception] = field(default_factory=list)
    model_host: str = "models.example"
    seen: list[httpx.Request] = field(default_factory=list)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        if request.url.host == "news.google.com":
            query = request.url.params["q"].removesuffix(" when:14d")
            feed = self.feeds.get(query, rss())
            if isinstance(feed, Exception):
                raise feed
            if isinstance(feed, int):
                return httpx.Response(feed)
            return httpx.Response(200, content=feed, headers={"Content-Type": "application/rss+xml"})
        if request.url.host == self.model_host:
            assert self.replies, "the model was asked more times than the test expected"
            answer = self.replies.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer
        raise AssertionError(f"a request left the test: {request.method} {request.url}")

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    @property
    def model_requests(self) -> list[httpx.Request]:
        return [r for r in self.seen if r.url.host == self.model_host]

    @property
    def model_bodies(self) -> list[dict[str, Any]]:
        return [json.loads(r.content) for r in self.model_requests]
