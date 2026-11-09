"""The Auto tab's provider for any OpenAI-compatible chat completions
endpoint with tools: OpenAI itself, OpenRouter, or a local server such as
ollama (`http://localhost:11434/v1`). One request per answer, not streamed:
servers differ most in how they stream tool calls, and least in how they
answer whole."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from typing import Any

import httpx

from .auto import Call, ProviderError, Reply
from .tools import Tool

# A local model on a small machine can take minutes over one answer.
TIMEOUT = httpx.Timeout(600.0, connect=10.0)


def tool_params(tools: Iterable[Tool]) -> list[dict]:
    return [{"type": "function", "function": {"name": tool.name, "description": tool.description, "parameters": tool.schema}} for tool in tools]


def _detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text.strip()[:500] or response.reason_phrase
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        return error["message"]
    if isinstance(error, str):
        return error
    return json.dumps(body)[:500]


class OpenAIChat:
    def __init__(
        self,
        base_url: str,
        model: str,
        key: str | None,
        system: str,
        tools: Iterable[Tool],
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        # From the backend's environment; a local server needs none.
        self.key = key
        self.tools = tool_params(tools)
        self.transport = transport
        self.messages: list[dict] = [{"role": "system", "content": system}]
        # Where the turn under way begins in the history.
        self._turn = len(self.messages)

    def seed(self, turns: list[tuple[str, str]]) -> None:
        for role, text in turns:
            self.messages.append({"role": role, "content": text})

    def add_user(self, text: str) -> None:
        self._turn = len(self.messages)
        self.messages.append({"role": "user", "content": text})

    def add_results(self, results: list[tuple[Call, str, bool]]) -> None:
        for call, text, error in results:
            self.messages.append({"role": "tool", "tool_call_id": call.id, "content": f"error: {text}" if error else text})

    async def reply(self, on_text: Callable[[str], None]) -> Reply:
        if not self.model:
            raise ProviderError("type the model's name for the OpenAI-compatible provider, as the server names it (for ollama, one that `ollama list` shows)")
        body = {"model": self.model, "messages": self.messages, "tools": self.tools, "tool_choice": "auto"}
        headers = {"Authorization": f"Bearer {self.key}"} if self.key else {}
        url = f"{self.base_url}/chat/completions"
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=TIMEOUT) as client:
                response = await client.post(url, json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise ProviderError(f"could not reach {self.base_url}: {exc!r}") from exc
        if response.status_code >= 400:
            raise ProviderError(f"{self.base_url} answered {response.status_code}: {_detail(response)}")
        try:
            choice = response.json()["choices"][0]
            message = choice["message"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError(f"{self.base_url} answered with no message: {response.text[:300]}") from exc
        text = message.get("content") or ""
        if not isinstance(text, str):
            text = json.dumps(text)
        if text:
            on_text(text)
        calls: list[Call] = []
        sent: list[dict] = []
        for index, raw in enumerate(message.get("tool_calls") or []):
            function = raw.get("function") or {}
            written: Any = function.get("arguments")
            arguments: dict | None
            if isinstance(written, dict):
                arguments, written = written, json.dumps(written)
            else:
                try:
                    parsed = json.loads(written) if written else {}
                except (TypeError, ValueError):
                    parsed = None
                arguments = parsed if isinstance(parsed, dict) else None
            call_id = str(raw.get("id") or f"call_{index}")
            calls.append(Call(id=call_id, name=str(function.get("name") or ""), arguments=arguments, raw=None if arguments is not None else str(written)))
            sent.append({"id": call_id, "type": "function", "function": {"name": function.get("name") or "", "arguments": written or "{}"}})
        finish = choice.get("finish_reason")
        if finish == "content_filter":
            # Declined: the turn that was, the operator's message and all
            # that followed it, leaves the history, or the next message
            # would carry it again; its calls go with it, unanswered.
            del self.messages[self._turn :]
            return Reply(text=text, calls=[], stop="refusal")
        turn: dict[str, Any] = {"role": "assistant", "content": text or None}
        if sent:
            turn["tool_calls"] = sent
        self.messages.append(turn)
        if finish == "length":
            stop = "max_tokens"
        else:
            stop = "tool_use" if calls else "end"
        return Reply(text=text, calls=calls, stop=stop)
