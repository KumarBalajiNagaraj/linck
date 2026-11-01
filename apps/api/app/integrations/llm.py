"""A minimal OpenAI-compatible chat-completions client (LIN-10).

One call, POST `{base_url}/chat/completions`, which nearly every model host
speaks, the free ones included. The base URL may end with a slash or not:

    Google Gemini    https://generativelanguage.googleapis.com/v1beta/openai/   (the default)
    OpenRouter       https://openrouter.ai/api/v1                (models ending ":free")
    Groq             https://api.groq.com/openai/v1
    OpenCode Zen     https://opencode.ai/zen/v1
    Ollama, local    http://localhost:11434/v1                   (ignores the key)

No provider SDK: three settings choose the model (base URL, API key, model
name) and httpx does the rest.

The reply is untrusted text. This module only gets it here safely: bounded in
time and in size, with every failure turned into one `LLMError` whose message
is safe to log and to store. The key goes into the Authorization header and
nowhere else; nothing here logs headers, and an error text a host sends back
has the key scrubbed out. What the text SAYS is the caller's to check.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.integrations.bounded import TooLarge, read_bounded

log = logging.getLogger("linck.llm")

MAX_REPLY_BYTES = 1_000_000
CONNECT_TIMEOUT = 10.0
MAX_ERROR_TEXT = 200


class LLMError(RuntimeError):
    """The model could not be asked, or gave no usable answer. Never holds the key."""


@dataclass(frozen=True)
class ChatReply:
    text: str
    #: The model the host says answered. A router such as OpenRouter names the one it chose.
    model: str
    #: The host stopped at max_tokens, so the text is probably cut off.
    truncated: bool


class ChatClient:
    """One model on one host. The HTTP client is the caller's, and so is closing it."""

    def __init__(
        self,
        http: httpx.AsyncClient,
        *,
        base_url: str,
        model: str,
        api_key: str = "",
        timeout: float = 60.0,
    ) -> None:
        base = base_url.strip().rstrip("/")
        if not base or not model.strip():
            raise LLMError("no model is configured (LINCK_AI_BASE_URL and LINCK_AI_MODEL)")
        self._http = http
        self._url = f"{base}/chat/completions"
        self._key = api_key.strip()
        self._timeout = httpx.Timeout(timeout, connect=min(CONNECT_TIMEOUT, timeout))
        self.model = model.strip()

    def __repr__(self) -> str:
        return f"ChatClient(url={self._url!r}, model={self.model!r})"

    async def complete(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int,
        temperature: float = 0.2,
        json_mode: bool = True,
    ) -> ChatReply:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        status, data, raw = await self._post(body)
        if status == 400 and json_mode:
            # Not every host or model takes JSON mode, and Groq answers 400 when
            # the model's JSON fails Groq's own check. The prompt asks for JSON
            # either way and the caller parses strictly, so ask once without it.
            log.info("model host refused JSON mode (%s); asking without it", self._error_text(data, raw))
            del body["response_format"]
            status, data, raw = await self._post(body)
        if status != 200:
            raise self._failure(status, data, raw)
        return self._reply(data)

    async def _post(self, body: dict[str, Any]) -> tuple[int, Any, bytes]:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self._key:
            headers["Authorization"] = f"Bearer {self._key}"
        try:
            async with self._http.stream(
                "POST", self._url, json=body, headers=headers, timeout=self._timeout
            ) as response:
                raw = await read_bounded(response, MAX_REPLY_BYTES)
                status = response.status_code
        except TooLarge as exc:
            raise LLMError(f"the model's answer is too large: {exc}") from exc
        except httpx.TimeoutException as exc:
            raise LLMError(f"no answer from the model within {self._timeout.read:.0f} seconds") from exc
        except httpx.HTTPError as exc:
            raise LLMError(f"could not reach the model host ({type(exc).__name__})") from exc
        try:
            data = json.loads(raw) if raw else None
        except (ValueError, RecursionError):
            data = None
        return status, data, raw

    def _failure(self, status: int, data: Any, raw: bytes) -> LLMError:
        if status in (401, 403):
            # The host's own words are left out: some echo part of the key.
            return LLMError(f"the model host refused the API key ({status})")
        if status == 404:
            return LLMError(f"the model host has no model {self.model!r} at this address (404)")
        if status == 429:
            return LLMError("the model host is limiting requests (429); try again later")
        detail = self._error_text(data, raw)
        return LLMError(f"the model host answered {status}" + (f": {detail}" if detail else ""))

    def _error_text(self, data: Any, raw: bytes) -> str:
        """What the host said went wrong: one short line, the key scrubbed out."""
        error = data.get("error") if isinstance(data, dict) else None
        if isinstance(error, dict):
            text = str(error.get("message") or "")
        elif isinstance(error, str):
            text = error
        else:
            text = raw[: MAX_ERROR_TEXT * 4].decode("utf-8", "replace")
        if len(self._key) >= 6:
            text = text.replace(self._key, "***")
        return " ".join(text.split())[:MAX_ERROR_TEXT]

    def _reply(self, data: Any) -> ChatReply:
        if not isinstance(data, dict):
            raise LLMError("the model host's answer is not JSON")
        if data.get("error"):
            # OpenRouter reports some failures (a provider down, a daily cap) inside a 200.
            raise LLMError(f"the model host reported an error: {self._error_text(data, b'')}")
        choices = data.get("choices")
        first = choices[0] if isinstance(choices, list) and choices else None
        message = first.get("message") if isinstance(first, dict) else None
        text = message.get("content") if isinstance(message, dict) else None
        if not isinstance(first, dict) or not isinstance(text, str) or not text.strip():
            raise LLMError("the model's answer was empty")
        answered = data.get("model")
        named = " ".join(answered.split()) if isinstance(answered, str) else ""
        model = named if 0 < len(named) <= 200 and named.isprintable() else self.model
        return ChatReply(text=text, model=model, truncated=first.get("finish_reason") == "length")
