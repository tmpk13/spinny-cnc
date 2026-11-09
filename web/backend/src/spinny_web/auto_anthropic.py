"""The Auto tab's Anthropic provider: the Messages API with tool use,
streamed through the official SDK so an answer shows as it is written.

The history is kept as the API takes it and added to: every assistant turn
goes back whole (thinking blocks included, which the API needs unchanged),
every tool call is answered. A model that declines on a safety ground is
retried on another model by the API itself where it offers that
(`fallbacks`); the history then follows the rule for a turn that changed
model part way. A turn declined by every model is taken out whole, as the
API asks before going on.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from typing import Any

import anthropic

from .auto import Call, ProviderError, Reply
from .tools import Tool

# Room for a long answer; streamed, so no request waits on it.
MAX_TOKENS = 64000
EFFORT = "medium"
# The models the API retries on another model when they decline, and the
# beta that asks it to pick that model by the reason.
FALLBACK_MODELS = frozenset({"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"})
FALLBACK_BETA = "server-side-fallback-2026-07-01"
# A tool input streamed as written is not checked by the API: one that
# does not read as JSON at all is asked for again this many times.
JSON_RETRIES = 2
# A turn the API paused is sent back to go on, at most this many times.
MAX_PAUSES = 5
STOPS = {"end_turn": "end", "stop_sequence": "end", "tool_use": "tool_use", "max_tokens": "max_tokens", "model_context_window_exceeded": "context"}


def tool_params(tools: Iterable[Tool]) -> list[dict]:
    """The tools as the API takes them. Their inputs stream as written; the
    tool box checks each against its schema before it runs."""
    return [
        {"name": tool.name, "description": tool.description, "input_schema": tool.schema, "eager_input_streaming": True}
        for tool in tools
    ]


def _param(block: Any) -> dict:
    return block.model_dump(mode="json", by_alias=True, exclude_none=True)


def echo(blocks: list[Any]) -> tuple[list[dict], list[Any]]:
    """The assistant turn to send back, and its tool calls to make.

    After a fallback part way through an answer, what came before the last
    `fallback` block is the declining model's: only its text goes back,
    and none of its calls is made."""
    boundary = max((index for index, block in enumerate(blocks) if block.type == "fallback"), default=-1)
    if boundary < 0:
        kept = list(blocks)
    else:
        kept = [block for block in blocks[:boundary] if block.type == "text"] + list(blocks[boundary:])
    uses = [block for block in blocks[max(boundary, 0):] if block.type == "tool_use"]
    return [_param(block) for block in kept], uses


def _call(block: Any) -> Call:
    arguments = block.input if isinstance(block.input, dict) else None
    raw = None if arguments is not None else json.dumps(block.input)
    return Call(id=block.id, name=block.name, arguments=arguments, raw=raw)


class AnthropicChat:
    def __init__(
        self,
        model: str,
        system: str,
        tools: Iterable[Tool],
        client: Callable[[], anthropic.AsyncAnthropic] = anthropic.AsyncAnthropic,
    ) -> None:
        self.model = model
        self.system = system
        self.tools = tool_params(tools)
        # Credentials come from the environment: ANTHROPIC_API_KEY, or what
        # else the SDK takes. None of them passes through the page.
        self.client = client
        self.messages: list[dict] = []
        # Where the turn under way begins in the history.
        self._turn = 0

    def seed(self, turns: list[tuple[str, str]]) -> None:
        for role, text in turns:
            if self.messages or role == "user":
                self.messages.append({"role": role, "content": text})

    def add_user(self, text: str) -> None:
        self._turn = len(self.messages)
        self.messages.append({"role": "user", "content": text})

    def add_results(self, results: list[tuple[Call, str, bool]]) -> None:
        if results:
            self.messages.append(
                {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": call.id, "content": text, "is_error": error} for call, text, error in results],
                }
            )

    def params(self) -> dict:
        params: dict[str, Any] = {
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "system": self.system,
            "messages": self.messages,
            "tools": self.tools,
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": EFFORT},
            # The tools, the system prompt and the history so far are the
            # same on every request of a conversation: cached.
            "cache_control": {"type": "ephemeral"},
        }
        if self.model in FALLBACK_MODELS:
            params["betas"] = [FALLBACK_BETA]
            params["fallbacks"] = "default"
        return params

    async def reply(self, on_text: Callable[[str], None]) -> Reply:
        try:
            async with self.client() as client:
                return await self._reply(client, on_text)
        except anthropic.AuthenticationError as exc:
            raise ProviderError("the Anthropic API refused the credentials: set ANTHROPIC_API_KEY where the backend runs, and restart it") from exc
        except anthropic.PermissionDeniedError as exc:
            raise ProviderError(f"the Anthropic API refused this key: {exc.message}") from exc
        except anthropic.NotFoundError as exc:
            raise ProviderError(f"the Anthropic API has no model {self.model!r}: {exc.message}") from exc
        except anthropic.RateLimitError as exc:
            raise ProviderError("the Anthropic API is limiting this key's rate: try again in a minute") from exc
        except anthropic.APIStatusError as exc:
            raise ProviderError(f"the Anthropic API answered {exc.status_code}: {exc.message}") from exc
        except anthropic.APIConnectionError as exc:
            raise ProviderError(f"could not reach the Anthropic API: {exc}") from exc
        except anthropic.AnthropicError as exc:
            raise ProviderError(f"the Anthropic SDK: {exc}") from exc
        except TypeError as exc:
            # With no credentials at all the SDK raises this, not one of its own.
            if "authentication" in str(exc):
                raise ProviderError("no Anthropic credentials: set ANTHROPIC_API_KEY where the backend runs, and restart it") from exc
            raise

    async def _reply(self, client: anthropic.AsyncAnthropic, on_text: Callable[[str], None]) -> Reply:
        pauses = 0
        failures = 0
        while True:
            texts: list[str] = []
            try:
                async with client.beta.messages.stream(**self.params()) as stream:
                    async for event in stream:
                        if event.type == "content_block_start" and event.content_block.type == "text":
                            texts.append("")
                        elif event.type == "text":
                            if not texts:
                                texts.append("")
                            texts[-1] = event.snapshot
                            on_text("\n\n".join(part for part in texts if part))
                    message = await stream.get_final_message()
            except ValueError as exc:
                # A tool input that does not read as JSON at all ends the
                # stream before its block is whole: there is no call to
                # answer, so the answer is asked for again.
                failures += 1
                if failures > JSON_RETRIES:
                    raise ProviderError(f"the model's tool calls did not read as JSON, {failures} times: {exc}") from exc
                continue
            failures = 0
            text = "\n\n".join(block.text for block in message.content if block.type == "text" and block.text)
            if message.stop_reason == "refusal":
                # Declined by every model asked. The API asks for the turn
                # that was declined to go before going on, or it is declined
                # again: the operator's message and all that followed it
                # leave the history, and what came before stays as it was.
                del self.messages[self._turn :]
                details = message.stop_details
                note = (details.category or details.explanation) if details is not None else None
                return Reply(text=text, calls=[], stop="refusal", note=note)
            blocks, uses = echo(message.content)
            if blocks:
                self.messages.append({"role": "assistant", "content": blocks})
            if message.stop_reason == "pause_turn" and pauses < MAX_PAUSES:
                pauses += 1
                continue
            calls = [_call(block) for block in uses]
            stop = STOPS.get(message.stop_reason or "", "end")
            if calls and stop == "end":
                stop = "tool_use"
            return Reply(text=text, calls=calls, stop=stop)
