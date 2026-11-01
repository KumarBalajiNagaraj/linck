"""Industry news (LIN-10) without the database: the feed, the model client, the digest.

Every request goes to httpx.MockTransport (see industry_news_fakes.py); nothing
here can reach the network. The rules worth a test each:

- a feed is untrusted: bad XML, a DTD, an oversized body and unsafe links are
  refused, and the same story is kept once;
- the model never handles a link, and an item carrying one that is not the
  feed's own, or naming a headline that was not on the list, is dropped;
- a reply that cannot be used is asked for once more, then the digest falls
  back to the top headlines by keyword, as it does with no model configured;
- the API key goes in the Authorization header and nowhere else.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from industry_news_fakes import (
    CEMENT,
    FILM,
    FLATS,
    KEY,
    METRO,
    MODEL,
    MODEL_URL,
    MSAND,
    NOW,
    QUERIES,
    RAIN,
    TENDERS,
    FakeNet,
    article,
    line,
    model_reply,
    news_item,
    rss,
    two_feeds,
)
from pydantic import SecretStr

from app.core.settings import Settings, get_settings
from app.integrations.llm import MAX_REPLY_BYTES, ChatClient, LLMError
from app.integrations.news import (
    MAX_FEED_BYTES,
    Headline,
    NewsError,
    NewsUnavailable,
    dedupe,
    fetch_feed,
    fetch_headlines,
    parse_feed,
    safe_link,
)
from app.schemas.insights import Both
from app.services.industry_digest import (
    MAX_ITEMS,
    PROMPT_VERSION,
    OutputError,
    build_digest,
    parse_reply,
    relevance,
    shortlist,
)

# The keyword ranking's order for the fake feeds; FILM matters to nobody.
BY_KEYWORD = [MSAND, TENDERS, METRO, CEMENT, FLATS, RAIN]


def settings(**over: object):  # type: ignore[no-untyped-def]
    values: dict[str, object] = {
        "ai_base_url": MODEL_URL,
        "ai_model": MODEL,
        "ai_api_key": SecretStr(KEY),
        "news_queries": QUERIES,
        "ai_timeout_seconds": 60,
    }
    values.update(over)
    return get_settings().model_copy(update=values)


async def build(net: FakeNet, **over: object):  # type: ignore[no-untyped-def]
    async with httpx.AsyncClient(transport=net.transport()) as http:
        return await build_digest(settings(**over), http, now=NOW)


def candidates() -> list[Headline]:
    feeds = two_feeds()
    found = [h for q in QUERIES for h in parse_feed(feeds[q], now=NOW)]  # type: ignore[arg-type]
    return shortlist(dedupe(found))


# ---------------------------------------------------------------- the feed


def test_a_google_news_item_becomes_a_clean_headline() -> None:
    raw = "Builders &amp; developers meet <b>CMDA</b>‮ on approvals"
    [h] = parse_feed(rss(news_item(raw, "The Hindu", published="Sat, 31 Oct 2026 13:00:00 +0530")), now=NOW)
    # Unescaped, tags and the bidi override gone, and the paper's name off the end.
    assert h.title == "Builders & developers meet CMDA on approvals"
    assert h.source == "The Hindu"
    assert h.published_at == datetime(2026, 10, 31, 7, 30, tzinfo=UTC)
    assert h.link == article(raw)


@pytest.mark.parametrize(
    "link",
    [
        "javascript:alert(1)",
        "data:text/html,<b>hi</b>",
        "/rss/articles/relative",
        "ftp://news.google.com/x",
        "https://user:secret@news.google.com/x",
        "https://news.google.com/a b",
        "https://news.google.com:99999/x",
        "https://news.google.com/‮x",
        "https://",
        "",
    ],
)
def test_a_link_that_is_not_plain_http_is_never_kept(link: str) -> None:
    assert safe_link(link) is None
    assert parse_feed(rss(news_item(MSAND, link=link)), now=NOW) == []


def test_a_plain_link_is_kept() -> None:
    assert (
        safe_link(" https://news.google.com/rss/articles/CBMi?oc=5 ")
        == "https://news.google.com/rss/articles/CBMi?oc=5"
    )
    assert safe_link("http://paper.example/story") == "http://paper.example/story"


def test_an_item_without_a_title_or_a_readable_date_is_dropped() -> None:
    body = rss(
        news_item(MSAND),
        news_item(METRO, published="last Tuesday"),
        "<item><link>https://news.google.com/rss/articles/x</link>"
        "<pubDate>Sat, 31 Oct 2026 07:00:00 GMT</pubDate></item>",
    )
    assert [h.title for h in parse_feed(body, now=NOW)] == [MSAND]


def test_only_the_last_14_days_are_kept() -> None:
    body = rss(
        news_item(MSAND, published=NOW - timedelta(days=13, hours=23)),
        news_item(METRO, published=NOW - timedelta(days=14, hours=1)),
        news_item(CEMENT, published=NOW + timedelta(days=3)),
    )
    assert [h.title for h in parse_feed(body, now=NOW)] == [MSAND]


BILLION_LAUGHS = b"""<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>
<rss version="2.0"><channel><item><title>&c;</title></item></channel></rss>"""

EXTERNAL_ENTITY = b"""<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]>
<rss version="2.0"><channel><item><title>&secret;</title></item></channel></rss>"""


@pytest.mark.parametrize(
    "body",
    [
        b"<rss><channel><item><title>cut off half way",
        b"\xff\xfe\x00 not xml",
        b"",
        b"<html><body>Before you continue to Google</body></html>",
        BILLION_LAUGHS,
        EXTERNAL_ENTITY,
    ],
    ids=["truncated", "binary", "empty", "html-page", "entity-expansion", "external-entity"],
)
def test_a_feed_that_is_not_plain_rss_is_refused(body: bytes) -> None:
    with pytest.raises(NewsError):
        parse_feed(body, now=NOW)


async def test_an_oversized_feed_is_refused_without_reading_it_all() -> None:
    chunk = b"<!-- " + b"x" * 64_000 + b" -->"
    pulled = 0

    async def twice_the_limit():  # type: ignore[no-untyped-def]
        nonlocal pulled
        for _ in range(2 * MAX_FEED_BYTES // len(chunk)):
            pulled += 1
            yield chunk

    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=twice_the_limit()))
    async with httpx.AsyncClient(transport=transport) as http:
        with pytest.raises(NewsError, match="too large"):
            await fetch_feed(http, QUERIES[0], now=NOW)
    assert pulled <= MAX_FEED_BYTES // len(chunk) + 2


async def test_a_feed_that_declares_an_oversized_body_is_not_read() -> None:
    oversized = {"Content-Length": str(MAX_FEED_BYTES + 1)}
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=rss(), headers=oversized))
    async with httpx.AsyncClient(transport=transport) as http:
        with pytest.raises(NewsError, match="declared"):
            await fetch_feed(http, QUERIES[0], now=NOW)


def test_the_same_story_is_kept_once() -> None:
    first = Headline(MSAND, "DT Next", NOW, article(MSAND))
    same_link = Headline("M-sand costs more", "Another paper", NOW, article(MSAND))
    same_words = Headline("M-SAND prices rise, as quarry strike enters third day!", "PTI", NOW, article("x"))
    other = Headline(METRO, "The Hindu", NOW, article(METRO))
    assert dedupe([first, same_link, same_words, other]) == [first, other]


async def test_each_query_asks_for_india_in_english_and_the_last_14_days() -> None:
    net = FakeNet()
    async with httpx.AsyncClient(transport=net.transport()) as http:
        result = await fetch_headlines(http, QUERIES, now=NOW)
    asked = [r.url for r in net.seen]
    assert {(u.scheme, u.host, u.path) for u in asked} == {("https", "news.google.com", "/rss/search")}
    assert sorted(u.params["q"] for u in asked) == sorted(f"{q} when:14d" for q in QUERIES)
    assert {(u.params["hl"], u.params["gl"], u.params["ceid"]) for u in asked} == {("en-IN", "IN", "IN:en")}
    # Seven stories in two feeds, the one both found kept once, newest first.
    assert result.failed == [] and len(result.headlines) == 7
    times = [h.published_at for h in result.headlines]
    assert times == sorted(times, reverse=True) and result.headlines[0].title == FILM


async def test_a_feed_that_fails_leaves_the_others() -> None:
    net = FakeNet(feeds={**two_feeds(), QUERIES[1]: 503})
    async with httpx.AsyncClient(transport=net.transport()) as http:
        result = await fetch_headlines(http, QUERIES, now=NOW)
    assert result.failed == [QUERIES[1]]
    assert {h.title for h in result.headlines} == {MSAND, TENDERS, METRO, CEMENT}


@pytest.mark.parametrize(
    "failure",
    [500, httpx.ReadTimeout("slow"), httpx.ConnectError("refused"), b"<html>not a feed</html>", b"<rss/>"],
    ids=["500", "timeout", "unreachable", "not-rss", "no-items"],
)
async def test_no_usable_feed_means_no_news(failure: object) -> None:
    net = FakeNet(feeds=dict.fromkeys(QUERIES, failure))  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=net.transport()) as http:
        with pytest.raises(NewsUnavailable):
            await fetch_headlines(http, QUERIES, now=NOW)


# ---------------------------------------------------------------- ranking, and no model at all


def test_headlines_rank_by_what_matters_to_a_crusher() -> None:
    assert relevance(MSAND) > relevance(TENDERS) > relevance(RAIN) > relevance(FILM) == 0
    assert relevance("Tamil Nadu bans sand mining along the Palar") > relevance(METRO)
    # Whole words only: "report" is not a port, "train" is not rain.
    assert relevance("Train report") == 0


async def test_with_no_model_the_digest_is_the_top_headlines_by_keyword() -> None:
    net = FakeNet()
    digest = await build(net, ai_base_url="", ai_model="")
    assert (digest.status, digest.model, digest.prompt_version, digest.reply) == ("ai_off", None, None, None)
    assert net.model_requests == [], "nothing was sent to a model"
    assert [i.title for i in digest.items] == BY_KEYWORD
    assert all(i.summary is None and i.why is None for i in digest.items)
    assert all(i.link == article(i.title) for i in digest.items)
    assert len(digest.headlines) == 7


# ---------------------------------------------------------------- the model writes the lines


async def test_the_model_picks_by_number_and_each_link_is_the_feeds_own() -> None:
    net = FakeNet(replies=[model_reply([line(2), line(4)])])
    digest = await build(net)

    assert (digest.status, digest.model, digest.prompt_version) == ("summarised", MODEL, PROMPT_VERSION)
    assert [(i.title, i.link) for i in digest.items] == [(MSAND, article(MSAND)), (METRO, article(METRO))]
    assert digest.items[0].summary == Both(en="Plain line about headline 2.", ta="செய்தி 2 பற்றி ஒரு எளிய வரி.")
    assert digest.items[0].why == Both(en="Why headline 2 matters to us.", ta="செய்தி 2 நமக்கு ஏன் முக்கியம்.")
    assert digest.headlines[1].title == MSAND, "stored in the numbering the model saw"

    [request] = net.model_requests
    assert str(request.url) == f"{MODEL_URL}/chat/completions"
    assert request.headers["Authorization"] == f"Bearer {KEY}"
    [body] = net.model_bodies
    assert body["model"] == MODEL and body["response_format"] == {"type": "json_object"}
    prompt = body["messages"][1]["content"]
    # Numbered, dated in India, with the paper's name, and not one link.
    assert f"2. [2026-11-01] {MSAND} (DT Next)" in prompt and f"7. [2026-10-30] {RAIN}" in prompt
    assert "http" not in prompt and "http" not in body["messages"][0]["content"]


async def test_an_item_with_an_invented_link_or_an_unknown_headline_is_dropped() -> None:
    net = FakeNet(
        replies=[
            model_reply(
                [
                    line(99),  # no such headline
                    line(2, link="https://invented.example/m-sand-story"),  # a link the feed never gave
                    line(3, url=article(METRO)),  # a real link, but another headline's
                    line(4, link=article(METRO)),  # its own link: kept
                    line(4),  # the same headline again
                    line(5, ta="Cement prices rise."),  # "Tamil" that is English
                    line(6, whyEn=""),  # a line missing
                    line(True),  # not a number
                    line("1"),  # a number written as text still names headline 1
                    {"en": "no headline named"},
                ]
            )
        ]
    )
    digest = await build(net)
    assert digest.status == "summarised"
    assert [i.title for i in digest.items] == [METRO, FILM]
    fetched = {h.link for h in digest.headlines}
    assert all(i.link in fetched for i in digest.items)


def test_at_most_six_items_are_kept_and_every_line_is_cleaned() -> None:
    reply = json.dumps(
        {
            "items": [line(1, en="<script>alert(1)</script>  Big\nnews", whyEn="x" * 1000)]
            + [line(n) for n in range(2, 8)]
        },
        ensure_ascii=False,
    )
    items = parse_reply(reply, candidates())
    assert len(items) == MAX_ITEMS
    assert items[0].summary is not None and items[0].summary.en == "alert(1) Big news"
    assert items[0].why is not None and len(items[0].why.en) == 300 and items[0].why.en.endswith("…")


@pytest.mark.parametrize(
    "wrapping",
    ["```json\n{}\n```", "Here is the JSON you asked for:\n{}\nHope this helps."],
    ids=["fence", "sentence"],
)
def test_a_reply_inside_a_fence_or_a_sentence_is_still_read(wrapping: str) -> None:
    reply = wrapping.replace("{}", json.dumps({"items": [line(2)]}, ensure_ascii=False))
    [item] = parse_reply(reply, candidates())
    assert item.title == MSAND


async def test_an_unusable_reply_is_asked_for_once_more() -> None:
    chatter = "Sure! Here are the news items you asked for."
    net = FakeNet(replies=[model_reply(chatter), model_reply([line(2)])])
    digest = await build(net)
    assert digest.status == "summarised" and [i.title for i in digest.items] == [MSAND]
    first, second = net.model_bodies
    assert second["messages"][:2] == first["messages"]
    assert second["messages"][2] == {"role": "assistant", "content": chatter}
    assert "could not be used: the reply is not valid JSON" in second["messages"][3]["content"]


async def test_a_reply_cut_off_at_the_token_limit_is_asked_for_shorter() -> None:
    net = FakeNet(
        replies=[model_reply('{"items": [{"n": 2, "en": "M-sand', finish="length"), model_reply([line(2)])]
    )
    digest = await build(net)
    assert digest.status == "summarised"
    assert "cut off" in net.model_bodies[1]["messages"][-1]["content"]


@pytest.mark.parametrize(
    "bad",
    [
        "not json at all",
        '[{"n": 1}]',
        '{"items": "six good ones"}',
        '{"items": []}',
        json.dumps({"items": [line(42)]}, ensure_ascii=False),
        '{"items": [' * 5000,
    ],
    ids=["prose", "a-list", "items-not-a-list", "no-items", "unknown-headline", "deep-nesting"],
)
async def test_two_unusable_replies_leave_the_headlines_alone(bad: str) -> None:
    net = FakeNet(replies=[model_reply(bad), model_reply(bad)])
    digest = await build(net)
    assert (digest.status, digest.model, digest.prompt_version) == ("ai_failed", None, PROMPT_VERSION)
    assert [i.title for i in digest.items] == BY_KEYWORD
    assert all(i.summary is None for i in digest.items)
    # Kept for the record: what the model said, and why it was not used.
    assert digest.reply == bad[:20_000]
    assert digest.error is not None and digest.error.startswith(f"{MODEL}: ")


def test_parse_reply_says_why_nothing_could_be_used() -> None:
    with pytest.raises(OutputError, match=r"item 1: \"n\" is not a headline number from 1 to 7"):
        parse_reply(json.dumps({"items": [line(42)]}), candidates())


@pytest.mark.parametrize(
    ("answer", "said"),
    [
        (httpx.ReadTimeout("slow"), "no answer from the model within 60 seconds"),
        (httpx.ConnectError("refused"), "could not reach the model host (ConnectError)"),
        (httpx.Response(429, json={"error": {"message": "free-models-per-day"}}), "limiting requests (429)"),
        (httpx.Response(404, json={"error": "no such model"}), f"no model {MODEL!r} at this address (404)"),
        (httpx.Response(503, text="<html>upstream down</html>"), "answered 503: <html>upstream down</html>"),
        (httpx.Response(200, json={"error": {"message": "Provider returned error"}}), "reported an error"),
        (httpx.Response(200, json={"choices": []}), "answer was empty"),
        (httpx.Response(200, text="<html>a login page</html>"), "not JSON"),
    ],
    ids=[
        "timeout",
        "unreachable",
        "rate-limited",
        "no-model",
        "server-error",
        "error-in-200",
        "empty",
        "html",
    ],
)
async def test_a_model_that_fails_leaves_the_headlines_and_is_not_asked_again(
    answer: object, said: str
) -> None:
    net = FakeNet(replies=[answer])  # type: ignore[list-item]
    digest = await build(net)
    assert digest.status == "ai_failed" and digest.error is not None and said in digest.error
    assert len(net.model_requests) == 1
    assert [i.title for i in digest.items] == BY_KEYWORD


async def test_an_oversized_answer_is_refused() -> None:
    huge = b'{"choices": "' + b"x" * (MAX_REPLY_BYTES + 1) + b'"}'
    digest = await build(FakeNet(replies=[httpx.Response(200, content=huge)]))
    assert digest.status == "ai_failed" and digest.error is not None and "too large" in digest.error


async def test_a_host_without_json_mode_is_asked_again_without_it() -> None:
    refused = httpx.Response(400, json={"error": {"message": "response_format is not supported"}})
    net = FakeNet(replies=[refused, model_reply([line(2)])])
    digest = await build(net)
    assert digest.status == "summarised"
    first, second = net.model_bodies
    assert first["response_format"] == {"type": "json_object"} and "response_format" not in second


# ---------------------------------------------------------------- Gemini by default, and only with a key

GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai/"


def test_the_default_model_is_geminis_free_tier_with_no_key() -> None:
    defaults = Settings.model_fields
    assert defaults["ai_base_url"].default == GEMINI
    assert defaults["ai_model"].default == "gemini-2.5-flash"
    assert defaults["ai_api_key"].default.get_secret_value() == ""


@pytest.mark.parametrize("blank", ["", "   "], ids=["empty", "spaces"])
async def test_with_no_key_nothing_is_sent_to_any_model(blank: str) -> None:
    net = FakeNet(replies=[model_reply([line(2)])], model_host="generativelanguage.googleapis.com")
    digest = await build(net, ai_base_url=GEMINI, ai_model="gemini-2.5-flash", ai_api_key=SecretStr(blank))
    assert (digest.status, digest.model, digest.prompt_version) == ("ai_off", None, None)
    assert net.model_requests == []
    assert [i.title for i in digest.items] == BY_KEYWORD


async def test_with_a_key_gemini_is_asked_at_its_openai_compatible_address() -> None:
    net = FakeNet(
        replies=[model_reply([line(2)], model="gemini-2.5-flash")],
        model_host="generativelanguage.googleapis.com",
    )
    digest = await build(net, ai_base_url=GEMINI, ai_model="gemini-2.5-flash")
    assert (digest.status, digest.model) == ("summarised", "gemini-2.5-flash")
    [request] = net.model_requests
    assert (request.method, str(request.url)) == (
        "POST",
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    )
    assert request.headers["Authorization"] == f"Bearer {KEY}"
    assert net.model_bodies[0]["model"] == "gemini-2.5-flash"


@pytest.mark.parametrize(
    "base",
    [
        "https://generativelanguage.googleapis.com/v1beta/openai/",
        "https://generativelanguage.googleapis.com/v1beta/openai",
        " https://generativelanguage.googleapis.com/v1beta/openai// ",
    ],
    ids=["trailing-slash", "no-slash", "spaces-and-two-slashes"],
)
async def test_the_base_url_joins_chat_completions_with_one_slash(base: str) -> None:
    asked: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        asked.append(request)
        return model_reply("{}")

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as http:
        await ChatClient(http, base_url=base, model="gemini-2.5-flash", api_key=KEY).complete(
            [], max_tokens=10
        )
    assert [str(r.url) for r in asked] == [
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    ]


async def test_a_local_ollama_takes_any_placeholder_key() -> None:
    net = FakeNet(replies=[model_reply([line(2)], model="gemma3:12b")], model_host="localhost")
    digest = await build(
        net, ai_base_url="http://localhost:11434/v1", ai_model="gemma3:12b", ai_api_key=SecretStr("ollama")
    )
    assert (digest.status, digest.model) == ("summarised", "gemma3:12b")
    [request] = net.model_requests
    assert str(request.url) == "http://localhost:11434/v1/chat/completions"


async def test_the_client_sends_no_authorization_header_without_a_key() -> None:
    asked: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        asked.append(request)
        return model_reply("{}")

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as http:
        await ChatClient(http, base_url="http://localhost:11434/v1", model="gemma3:12b").complete(
            [], max_tokens=10
        )
    assert "authorization" not in asked[0].headers


# ---------------------------------------------------------------- the key


async def test_the_key_goes_only_in_the_authorization_header() -> None:
    net = FakeNet(
        replies=[httpx.Response(401, json={"error": {"message": f"Incorrect API key provided: {KEY}"}})]
    )
    async with httpx.AsyncClient(transport=net.transport()) as http:
        chat = ChatClient(http, base_url=MODEL_URL, model=MODEL, api_key=KEY)
        with pytest.raises(LLMError) as refused:
            await chat.complete([{"role": "user", "content": "hello"}], max_tokens=10)
    assert str(refused.value) == "the model host refused the API key (401)"
    assert KEY not in repr(chat)
    [request] = net.model_requests
    assert request.headers["Authorization"] == f"Bearer {KEY}"
    assert KEY not in str(request.url) and KEY not in request.content.decode()


async def test_a_key_a_host_echoes_back_is_scrubbed_from_the_error() -> None:
    net = FakeNet(replies=[httpx.Response(500, json={"error": {"message": f"upstream refused {KEY} today"}})])
    digest = await build(net)
    assert (
        digest.error is not None and KEY not in digest.error and "upstream refused *** today" in digest.error
    )


def test_the_settings_never_show_the_key() -> None:
    configured = settings()
    assert KEY not in repr(configured) and KEY not in str(configured.model_dump())
    assert configured.ai_api_key.get_secret_value() == KEY
