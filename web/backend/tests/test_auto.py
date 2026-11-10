"""The Auto tab's agent: the tool loop with a model that answers from a
script, the cap and the stop, the settings, the routes and their guard,
and each provider against a fake of what it talks to (no real model is
asked anything)."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import anthropic
import httpx
import httpx2
import pytest
from fastapi.testclient import TestClient

from spinny_web import auto as auto_module
from spinny_web.app import Backend, create_app
from spinny_web.auto import RAN_ON, SYSTEM_PROMPT, Agent, Call, ChatSession, Entry, ProviderError, Reply
from spinny_web.auto_anthropic import AnthropicChat, echo
from spinny_web.auto_claude import ClaudeCodeSession, command
from spinny_web.auto_openai import OpenAIChat
from spinny_web.tools import TOOLS, Outcome


class FakeChat:
    """A model that answers from a script; each step is a Reply, or a
    coroutine function given the text callback that makes one."""

    def __init__(self, *steps) -> None:
        self.steps = list(steps)
        self.users: list[str] = []
        self.results: list[list[tuple[Call, str, bool]]] = []
        self.seeded: list[tuple[str, str]] | None = None

    def seed(self, turns):
        self.seeded = list(turns)

    def add_user(self, text):
        self.users.append(text)

    async def reply(self, on_text):
        step = self.steps.pop(0) if len(self.steps) > 1 else self.steps[0]
        if callable(step):
            return await step(on_text)
        if step.text:
            on_text(step.text)
        return step

    def add_results(self, results):
        self.results.append(list(results))


def use(agent: Agent, chat, provider: str = "anthropic") -> None:
    agent.factories[provider] = lambda agent, choice: ChatSession(chat, agent.max_calls)


@pytest.fixture
def client(tmp_path):
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.agent = app.state.auto
        yield client


def settle(client, timeout: float = 10.0) -> dict:
    """The conversation once its turn has ended."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = client.get("/api/auto/conversation").json()
        if not state["busy"]:
            return state
        time.sleep(0.01)
    raise AssertionError("the turn did not end")


def wait_for(client, check, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = client.get("/api/auto/conversation").json()
        if check(state):
            return state
        time.sleep(0.01)
    raise AssertionError("never came")


def roles(state: dict) -> list[str]:
    return [entry["role"] for entry in state["entries"]]


# --- the loop -------------------------------------------------------------------


def test_a_turn_calls_a_tool_in_the_app_and_streams_every_step(client):
    chat = FakeChat(
        Reply(text="Looking at the jobs.", calls=[Call("c1", "list_jobs", {})], stop="tool_use"),
        Reply(text="There are no jobs yet.", calls=[], stop="end"),
    )
    use(client.agent, chat)
    with client.websocket_connect("/ws") as socket:
        assert socket.receive_json()["type"] == "state"
        response = client.post("/api/auto/messages", json={"text": "  what jobs are there?  "})
        assert response.status_code == 200, response.text
        assert response.json()["busy"] is True
        events = []
        while True:
            event = socket.receive_json()
            if event["type"] != "auto":
                continue
            events.append(event)
            if event["entry"] is None and not event["busy"]:
                break
    state = settle(client)
    assert roles(state) == ["user", "assistant", "tool", "assistant"]
    user, first, tool, last = state["entries"]
    assert user["text"] == "what jobs are there?" and chat.users == ["what jobs are there?"]
    assert first == {"id": first["id"], "role": "assistant", "text": "Looking at the jobs.", "done": True}
    assert tool["name"] == "list_jobs" and tool["arguments"] == {} and tool["done"] and not tool["error"]
    assert json.loads(tool["result"]) == {"jobs": []} and tool["changed"] == []
    assert last["text"] == "There are no jobs yet."
    # What the tool answered went back to the model, under the call's id.
    assert [(call.id, text, error) for call, text, error in chat.results[0]] == [("c1", tool["result"], False)]
    # The page saw the tool both running and done, under one id.
    shown = [event["entry"] for event in events if event["entry"] and event["entry"]["role"] == "tool"]
    assert [entry["done"] for entry in shown] == [False, True] and len({entry["id"] for entry in shown}) == 1


def test_a_tool_that_makes_a_job_says_so(client):
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20"><circle cx="10" cy="10" r="5" stroke="#000" fill="none"/></svg>'
    chat = FakeChat(
        Reply(text="", calls=[Call("c1", "make_job", {"filename": "ring.svg", "content": svg, "power": 200})], stop="tool_use"),
        Reply(text="Made ring.", calls=[], stop="end"),
    )
    use(client.agent, chat)
    client.post("/api/auto/messages", json={"text": "make a ring"})
    state = settle(client)
    assert roles(state) == ["user", "tool", "assistant"]
    tool = state["entries"][1]
    assert not tool["error"], tool["result"] and tool["changed"] == ["jobs"]
    assert tool["changed"] == ["jobs"]
    jobs = client.get("/api/jobs").json()["jobs"]
    assert [job["name"] for job in jobs] == ["ring"] and jobs[0]["groups"][0]["power"] == 200


def test_a_model_that_keeps_calling_is_stopped_at_the_cap(client):
    client.agent.max_calls = 3
    chat = FakeChat(Reply(text="", calls=[Call("a", "list_jobs", {}), Call("b", "list_markers", {})], stop="tool_use"))
    use(client.agent, chat)
    client.post("/api/auto/messages", json={"text": "loop"})
    state = settle(client)
    assert roles(state).count("tool") == 3
    assert state["entries"][-1]["role"] == "notice" and "after 3 tool calls" in state["entries"][-1]["text"]
    # Every call asked for is answered, the one past the cap as not run.
    assert [[error for _, _, error in results] for results in chat.results] == [[False, False], [False, True]]
    assert "at most 3 tool calls" in chat.results[1][1][1]


def test_a_stop_ends_the_answer_being_written_and_the_next_message_goes_on(client):
    async def hang(on_text):
        on_text("Thinking about")
        await asyncio.Event().wait()

    chat = FakeChat(hang, Reply(text="Here again.", calls=[], stop="end"))
    use(client.agent, chat)
    client.post("/api/auto/messages", json={"text": "first"})
    wait_for(client, lambda state: any(entry["role"] == "assistant" for entry in state["entries"]))
    assert client.post("/api/auto/messages", json={"text": "too soon"}).status_code == 409
    stopped = client.post("/api/auto/stop").json()
    assert stopped["busy"] is False
    assert roles(stopped) == ["user", "assistant", "notice"]
    assert stopped["entries"][1] == {"id": stopped["entries"][1]["id"], "role": "assistant", "text": "Thinking about", "done": True}
    assert stopped["entries"][2]["text"] == "Stopped."
    client.post("/api/auto/messages", json={"text": "second"})
    state = settle(client)
    assert state["entries"][-1]["text"] == "Here again." and chat.users == ["first", "second"]


def test_a_stop_during_a_tool_call_answers_every_call(client, monkeypatch):
    monkeypatch.setattr(auto_module, "STOP_WAIT", 0.2)

    class Hanging:
        async def call(self, name, arguments):
            await asyncio.Event().wait()

        async def aclose(self):
            pass

    client.agent.toolbox = Hanging
    chat = FakeChat(Reply(text="", calls=[Call("a", "list_jobs", {}), Call("b", "list_markers", {})], stop="tool_use"))
    use(client.agent, chat)
    client.post("/api/auto/messages", json={"text": "go"})
    wait_for(client, lambda state: any(entry["role"] == "tool" for entry in state["entries"]))
    state = client.post("/api/auto/stop").json()
    tool = state["entries"][1]
    assert tool["done"] and tool["error"] and tool["result"] == RAN_ON
    assert sorted(call.id for call, _, _ in chat.results[0]) == ["a", "b"]
    assert all(error and "stopped" in text for _, text, error in chat.results[0])


def slow_imports(client, seconds: float) -> threading.Event:
    """Makes every upload's import take `seconds` in its thread; the event
    is set when one has begun."""
    backend = client.app.state.backend
    begun = threading.Event()
    original = backend.import_upload

    def slow(*args, **kwargs):
        begun.set()
        time.sleep(seconds)
        return original(*args, **kwargs)

    backend.import_upload = slow
    return begun


RING = '<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20"><circle cx="10" cy="10" r="5" stroke="#000" fill="none"/></svg>'


def test_a_stop_while_a_call_runs_tells_what_came_of_it(client):
    # The import goes on in its thread whatever the stop does: it is waited
    # for, and the model and the page are told what it made.
    begun = slow_imports(client, 0.5)
    chat = FakeChat(Reply(text="", calls=[Call("c1", "make_job", {"filename": "ring.svg", "content": RING}), Call("c2", "list_jobs", {})], stop="tool_use"))
    use(client.agent, chat)
    client.post("/api/auto/messages", json={"text": "make a ring"})
    assert begun.wait(5.0)
    state = client.post("/api/auto/stop").json()
    assert roles(state) == ["user", "tool", "notice"]
    tool = state["entries"][1]
    assert tool["done"] and not tool["error"] and tool["changed"] == ["jobs"] and json.loads(tool["result"])["name"] == "ring"
    told = {call.id: (text, error) for call, text, error in chat.results[0]}
    assert told["c1"] == (tool["result"], False)
    assert told["c2"] == ("not run: the operator stopped the turn", True)
    assert [job["name"] for job in client.get("/api/jobs").json()["jobs"]] == ["ring"]


def test_a_call_running_on_past_the_stop_is_told_as_maybe_done_and_shown_when_it_ends(client, monkeypatch):
    monkeypatch.setattr(auto_module, "STOP_WAIT", 0.2)
    begun = slow_imports(client, 1.0)
    chat = FakeChat(Reply(text="", calls=[Call("c1", "make_job", {"filename": "ring.svg", "content": RING})], stop="tool_use"))
    use(client.agent, chat)
    client.post("/api/auto/messages", json={"text": "make a ring"})
    assert begun.wait(5.0)
    state = client.post("/api/auto/stop").json()
    tool = state["entries"][1]
    # Maybe done: the page lists the jobs again, and the model looks first.
    assert tool["done"] and tool["error"] and tool["result"] == RAN_ON and tool["changed"] == ["jobs"]
    assert [(call.id, text) for call, text, _ in chat.results[0]] == [("c1", RAN_ON)]
    state = wait_for(client, lambda state: state["entries"][1]["result"].startswith("after the stop: "))
    tool = state["entries"][1]
    assert not tool["error"] and tool["changed"] == ["jobs"] and json.loads(tool["result"][len("after the stop: ") :])["name"] == "ring"
    assert [job["name"] for job in client.get("/api/jobs").json()["jobs"]] == ["ring"]


def test_a_turn_that_fails_in_a_call_ends_the_call_and_says_why(client):
    class Broken:
        async def call(self, name, arguments):
            raise RuntimeError("boom")

        async def aclose(self):
            pass

    client.agent.toolbox = Broken
    chat = FakeChat(Reply(text="", calls=[Call("a", "list_jobs", {}), Call("b", "list_markers", {})], stop="tool_use"))
    use(client.agent, chat)
    client.post("/api/auto/messages", json={"text": "go"})
    state = settle(client)
    assert roles(state) == ["user", "tool", "error"]
    tool = state["entries"][1]
    assert tool["done"] and tool["error"] and "boom" in tool["result"]
    # The model is told what happened, not that the operator stopped it.
    told = {call.id: text for call, text, _ in chat.results[0]}
    assert "boom" in told["a"] and told["b"].startswith("not run: the turn failed")
    assert not any("operator" in text for text in told.values())


def test_a_provider_that_fails_is_an_error_in_the_conversation(client):
    async def refuse(on_text):
        raise ProviderError("no Anthropic credentials: set ANTHROPIC_API_KEY")

    async def crash(on_text):
        raise RuntimeError("boom")

    use(client.agent, FakeChat(refuse, crash))
    client.post("/api/auto/messages", json={"text": "hello"})
    state = settle(client)
    assert state["entries"][-1] == {"id": state["entries"][-1]["id"], "role": "error", "text": "no Anthropic credentials: set ANTHROPIC_API_KEY", "done": True}
    client.post("/api/auto/messages", json={"text": "again"})
    state = settle(client)
    assert state["entries"][-1]["role"] == "error" and "boom" in state["entries"][-1]["text"]
    assert client.post("/api/auto/messages", json={"text": "   "}).status_code == 400
    too_long = client.post("/api/auto/messages", json={"text": "x" * 20001})
    assert too_long.status_code == 400 and "20000" in too_long.json()["detail"]


def test_refusals_cut_answers_and_bad_json_are_told_not_run(client):
    chat = FakeChat(
        Reply(text="", calls=[Call("a", "list_jobs", None, raw='{"x": ')], stop="tool_use"),
        Reply(text="half", calls=[Call("b", "list_jobs", {})], stop="max_tokens"),
        Reply(text="", calls=[], stop="refusal", note="cyber"),
    )
    use(client.agent, chat)
    client.post("/api/auto/messages", json={"text": "one"})
    state = settle(client)
    tool = state["entries"][1]
    assert tool["error"] and json.loads(tool["result"]) == {"INVALID_JSON": '{"x": '}
    assert state["entries"][-1]["role"] == "notice" and "cut off" in state["entries"][-1]["text"]
    assert chat.results[1][0][2] is True and "cut off" in chat.results[1][0][1]
    client.post("/api/auto/messages", json={"text": "two"})
    state = settle(client)
    assert "declined" in state["entries"][-1]["text"] and "cyber" in state["entries"][-1]["text"]


def test_a_new_chat_clears_and_a_new_provider_starts_from_the_text(client):
    first = FakeChat(Reply(text="Hi there.", calls=[], stop="end"))
    use(client.agent, first)
    client.post("/api/auto/messages", json={"text": "hello"})
    settle(client)
    assert first.seeded == []
    second = FakeChat(Reply(text="Still here.", calls=[], stop="end"))
    use(client.agent, second, "openai")
    assert client.put("/api/auto/settings", json={"provider": "openai", "model": "local"}).status_code == 200
    client.post("/api/auto/messages", json={"text": "and now?"})
    settle(client)
    assert second.seeded == [("user", "hello"), ("assistant", "Hi there.")]
    with client.websocket_connect("/ws") as socket:
        socket.receive_json()
        cleared = client.delete("/api/auto/conversation").json()
        assert cleared == {"entries": [], "busy": False}
        while (event := socket.receive_json())["type"] != "auto":
            pass
        assert event == {"type": "auto", "entry": None, "busy": False, "cleared": True}
    third = FakeChat(Reply(text="New.", calls=[], stop="end"))
    use(client.agent, third, "openai")
    client.post("/api/auto/messages", json={"text": "fresh"})
    settle(client)
    assert third.seeded == []


# --- settings and the routes' guard ------------------------------------------------


def test_settings_say_whether_keys_are_there_and_never_what_they_are(client, monkeypatch, tmp_path):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    client.agent.which = lambda name: None
    settings = client.get("/api/auto/settings").json()
    assert settings["provider"] == "anthropic" and settings["model"] == "" and settings["max_tool_calls"] == 25
    providers = {entry["id"]: entry for entry in settings["providers"]}
    assert providers["anthropic"]["default_model"] == "claude-opus-5-5"
    assert providers["anthropic"]["key_present"] is False and "ANTHROPIC_API_KEY" in providers["anthropic"]["note"]
    assert providers["openai"]["key_present"] is False and providers["openai"]["ready"] is True
    assert providers["claude-code"]["ready"] is False and "PATH" in providers["claude-code"]["note"]
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret-1234")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-secret-5678")
    client.agent.which = lambda name: "/opt/bin/claude"
    response = client.get("/api/auto/settings")
    assert "secret" not in response.text
    providers = {entry["id"]: entry for entry in response.json()["providers"]}
    assert providers["anthropic"]["key_present"] is True and providers["anthropic"]["note"] is None
    assert providers["openai"]["key_present"] is True
    assert providers["claude-code"]["ready"] is True and "/opt/bin/claude" in providers["claude-code"]["note"]


def test_settings_are_checked_and_kept_in_the_config(client, tmp_path):
    for body in ({"provider": "gemini"}, {"base_url": "ftp://host"}, {"model": "two words"}, {"provider": "openai", "base_url": "http://"}):
        response = client.put("/api/auto/settings", json=body)
        assert response.status_code == 400, body
    assert "auto" not in json.loads((tmp_path / "config.json").read_text()) if (tmp_path / "config.json").exists() else True
    kept = client.put("/api/auto/settings", json={"provider": "openai", "model": "qwen2.5:7b", "base_url": "http://box:11434/v1"}).json()
    assert kept["provider"] == "openai" and kept["model"] == "qwen2.5:7b" and kept["base_url"] == "http://box:11434/v1"
    kept = client.put("/api/auto/settings", json={"provider": "anthropic"}).json()
    assert kept["model"] == "" and kept["models"]["openai"] == "qwen2.5:7b"
    kept = client.put("/api/auto/settings", json={"model": "claude-sonnet-5-5"}).json()
    assert kept["models"] == {"anthropic": "claude-sonnet-5-5", "openai": "qwen2.5:7b", "claude-code": ""}
    config = json.loads((tmp_path / "config.json").read_text())
    assert config["auto"] == {"provider": "anthropic", "models": {"openai": "qwen2.5:7b", "anthropic": "claude-sonnet-5-5"}, "base_url": "http://box:11434/v1"}


def test_the_auto_routes_refuse_a_page_from_another_origin(client):
    use(client.agent, FakeChat(Reply(text="ok", calls=[], stop="end")))
    evil = {"Origin": "http://evil.example"}
    assert client.post("/api/auto/messages", json={"text": "hi"}, headers=evil).status_code == 403
    assert client.put("/api/auto/settings", json={"provider": "openai"}, headers=evil).status_code == 403
    assert client.post("/api/auto/stop", headers=evil).status_code == 403
    assert client.delete("/api/auto/conversation", headers=evil).status_code == 403
    assert client.get("/api/auto/conversation").json()["entries"] == []
    # The page's own origin, and a script with none, go through.
    assert client.post("/api/auto/messages", json={"text": "hi"}, headers={"Origin": "http://testserver"}).status_code == 200
    settle(client)
    assert client.post("/api/auto/stop").status_code == 200


def test_the_tools_get_through_an_allowed_host_list(tmp_path):
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    app = create_app(backend, frontend=tmp_path / "no-dist", allowed_hosts=["spinny.local"])
    with TestClient(app, base_url="http://spinny.local") as client:
        use(app.state.auto, FakeChat(Reply(text="", calls=[Call("a", "list_jobs", {})], stop="tool_use"), Reply(text="done", calls=[], stop="end")))
        client.post("/api/auto/messages", json={"text": "jobs?"})
        state = settle(client)
        assert not state["entries"][1]["error"], state["entries"][1]["result"]
    with TestClient(app, base_url="http://evil.example") as other:
        assert other.get("/api/state").status_code == 400


# --- the Anthropic provider, through the real SDK ------------------------------------


def sse(*events: dict) -> bytes:
    return "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()


def message_start() -> dict:
    return {
        "type": "message_start",
        "message": {"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 1}},
    }


def answer_with_a_call() -> bytes:
    return sse(
        message_start(),
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig-1"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Let me "}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "look."}},
        {"type": "content_block_stop", "index": 1},
        {"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "list_jobs", "input": {}}},
        {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "{}"}},
        {"type": "content_block_stop", "index": 2},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 20}},
        {"type": "message_stop"},
    )


def answer_in_text(text: str) -> bytes:
    return sse(
        message_start(),
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 5}},
        {"type": "message_stop"},
    )


def test_the_anthropic_provider_streams_a_tool_round_trip_through_the_sdk(client):
    requests: list[httpx2.Request] = []
    answers = [answer_with_a_call(), answer_in_text("No jobs yet.")]

    def handler(request: httpx2.Request) -> httpx2.Response:
        requests.append(request)
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=answers[len(requests) - 1])

    def sdk() -> anthropic.AsyncAnthropic:
        return anthropic.AsyncAnthropic(api_key="test-key", http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)), max_retries=0)

    client.agent.factories["anthropic"] = lambda agent, choice: ChatSession(AnthropicChat(choice.model_or_default, SYSTEM_PROMPT, TOOLS, client=sdk), agent.max_calls)
    client.post("/api/auto/messages", json={"text": "jobs?"})
    state = settle(client)
    assert roles(state) == ["user", "assistant", "tool", "assistant"], state
    assert state["entries"][1]["text"] == "Let me look." and state["entries"][3]["text"] == "No jobs yet."
    assert json.loads(state["entries"][2]["result"]) == {"jobs": []}
    first = json.loads(requests[0].content)
    assert requests[0].url.path == "/v1/messages"
    assert "server-side-fallback-2026-07-01" in requests[0].headers["anthropic-beta"]
    assert first["model"] == "claude-opus-5-5" and first["stream"] is True and first["max_tokens"] == 64000
    assert first["thinking"] == {"type": "adaptive"} and first["output_config"] == {"effort": "medium"}
    assert first["fallbacks"] == "default" and first["cache_control"] == {"type": "ephemeral"}
    assert first["system"] == SYSTEM_PROMPT
    assert [tool["name"] for tool in first["tools"]] == [tool.name for tool in TOOLS]
    assert all(tool["eager_input_streaming"] is True for tool in first["tools"])
    assert first["tools"][0]["input_schema"] == TOOLS[0].schema
    assert first["messages"] == [{"role": "user", "content": "jobs?"}]
    second = json.loads(requests[1].content)["messages"]
    assert [message["role"] for message in second] == ["user", "assistant", "user"]
    # The assistant turn goes back whole, its thinking block unchanged.
    assert [block["type"] for block in second[1]["content"]] == ["thinking", "text", "tool_use"]
    assert second[1]["content"][0]["signature"] == "sig-1"
    assert second[2]["content"] == [{"type": "tool_result", "tool_use_id": "toolu_1", "content": state["entries"][2]["result"], "is_error": False}]


def answer_calling(name: str, arguments: dict, stop: str = "tool_use") -> bytes:
    return sse(
        message_start(),
        {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_9", "name": name, "input": {}}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(arguments)}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 20}},
        {"type": "message_stop"},
    )


def answer_declined() -> bytes:
    return sse(
        message_start(),
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "I can"}},
        {"type": "content_block_stop", "index": 0},
        {
            "type": "message_delta",
            "delta": {"stop_reason": "refusal", "stop_sequence": None, "stop_details": {"type": "refusal", "category": "cyber", "explanation": None}},
            "usage": {"output_tokens": 3},
        },
        {"type": "message_stop"},
    )


def test_after_a_refusal_the_next_message_starts_clean(client):
    # The API asks for the declined turn to be taken out before going on;
    # sent again with the next message, it is declined again.
    requests: list[httpx2.Request] = []
    answers = [
        answer_declined(),
        answer_in_text("Done."),
        answer_calling("save_marker", {"name": "corner", "x": 1, "y": 2}),
        answer_declined(),
        answer_in_text("Saved before."),
    ]

    def handler(request: httpx2.Request) -> httpx2.Response:
        requests.append(request)
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=answers[len(requests) - 1])

    def sdk() -> anthropic.AsyncAnthropic:
        return anthropic.AsyncAnthropic(api_key="test-key", http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)), max_retries=0)

    client.agent.factories["anthropic"] = lambda agent, choice: ChatSession(AnthropicChat(choice.model_or_default, SYSTEM_PROMPT, TOOLS, client=sdk), agent.max_calls)
    client.post("/api/auto/messages", json={"text": "the first, declined"})
    state = settle(client)
    assert state["entries"][-1]["role"] == "notice" and "declined this (cyber)" in state["entries"][-1]["text"]
    client.post("/api/auto/messages", json={"text": "put another way"})
    settle(client)
    assert json.loads(requests[1].content)["messages"] == [{"role": "user", "content": "put another way"}]
    # A declined turn whose calls ran: they stay done, and the next message
    # says so, since the turn they were in is gone.
    client.post("/api/auto/messages", json={"text": "save a corner"})
    settle(client)
    assert client.get("/api/markers").json()["markers"] == [{"name": "corner", "x": 1.0, "y": 2.0}]
    client.post("/api/auto/messages", json={"text": "and again"})
    settle(client)
    messages = json.loads(requests[4].content)["messages"]
    assert [message["role"] for message in messages] == ["user", "assistant", "user"]
    assert messages[0] == {"role": "user", "content": "put another way"}
    assert "save_marker" in messages[2]["content"] and messages[2]["content"].endswith("and again")


def test_after_a_content_filter_the_next_message_starts_clean(client):
    # A server that holds to the chat completions rule: every tool call of
    # an assistant turn is answered before anything else is sent.
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        owed: set[str] = set()
        for message in body["messages"]:
            if owed and message["role"] != "tool":
                return httpx.Response(400, json={"error": {"message": "An assistant message with 'tool_calls' must be followed by tool messages"}})
            if message["role"] == "assistant":
                owed = {call["id"] for call in message.get("tool_calls") or []}
            elif message["role"] == "tool":
                owed.discard(message["tool_call_id"])
        if len(bodies) == 1:
            calls = [{"id": "call_1", "type": "function", "function": {"name": "list_jobs", "arguments": "{}"}}]
            return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "Let me", "tool_calls": calls}, "finish_reason": "content_filter"}]})
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "Here."}, "finish_reason": "stop"}]})

    def make(agent, choice):
        return ChatSession(OpenAIChat(choice.base_url, choice.model, None, SYSTEM_PROMPT, TOOLS, transport=httpx.MockTransport(handler)), agent.max_calls)

    client.agent.factories["openai"] = make
    client.put("/api/auto/settings", json={"provider": "openai", "model": "llama3.1"})
    client.post("/api/auto/messages", json={"text": "jobs?"})
    state = settle(client)
    assert "declined" in state["entries"][-1]["text"]
    client.post("/api/auto/messages", json={"text": "put another way"})
    state = settle(client)
    assert state["entries"][-1] == {"id": state["entries"][-1]["id"], "role": "assistant", "text": "Here.", "done": True}
    assert bodies[1]["messages"][1:] == [{"role": "user", "content": "put another way"}]


def test_a_context_stop_or_a_declined_answer_with_calls_answers_them(client):
    chat = FakeChat(
        Reply(text="", calls=[Call("t", "list_jobs", {})], stop="context"),
        Reply(text="", calls=[Call("r", "list_jobs", {})], stop="refusal"),
    )
    use(client.agent, chat)
    client.post("/api/auto/messages", json={"text": "jobs?"})
    state = settle(client)
    assert "longer than the model takes" in state["entries"][-1]["text"]
    client.post("/api/auto/messages", json={"text": "again"})
    settle(client)
    # None of them ran, and each is answered, so the history stays one the
    # provider takes.
    assert [[(call.id, error) for call, _, error in results] for results in chat.results] == [[("t", True)], [("r", True)]]
    assert all(text.startswith("not run: ") for results in chat.results for _, text, _ in results)
    assert roles(state).count("tool") == 0


def test_a_call_cut_off_at_the_context_window_is_answered_in_the_history(client):
    requests: list[httpx2.Request] = []
    answers = [answer_calling("list_jobs", {}, stop="model_context_window_exceeded"), answer_in_text("Hm.")]

    def handler(request: httpx2.Request) -> httpx2.Response:
        requests.append(request)
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=answers[len(requests) - 1])

    def sdk() -> anthropic.AsyncAnthropic:
        return anthropic.AsyncAnthropic(api_key="test-key", http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)), max_retries=0)

    client.agent.factories["anthropic"] = lambda agent, choice: ChatSession(AnthropicChat(choice.model_or_default, SYSTEM_PROMPT, TOOLS, client=sdk), agent.max_calls)
    client.post("/api/auto/messages", json={"text": "jobs?"})
    settle(client)
    client.post("/api/auto/messages", json={"text": "again"})
    settle(client)
    messages = json.loads(requests[1].content)["messages"]
    assert [message["role"] for message in messages] == ["user", "assistant", "user", "user"]
    assert messages[1]["content"][0]["type"] == "tool_use"
    [result] = messages[2]["content"]
    assert result["type"] == "tool_result" and result["tool_use_id"] == "toolu_9" and result["is_error"] is True


def test_a_declined_turn_is_not_handed_to_a_provider_picked_after_it(client):
    first = FakeChat(Reply(text="Hi.", calls=[], stop="end"), Reply(text="", calls=[], stop="refusal", note="cyber"))
    use(client.agent, first)
    client.post("/api/auto/messages", json={"text": "hello"})
    settle(client)
    client.post("/api/auto/messages", json={"text": "the declined one"})
    settle(client)
    second = FakeChat(Reply(text="Here.", calls=[], stop="end"))
    use(client.agent, second, "openai")
    client.put("/api/auto/settings", json={"provider": "openai", "model": "local"})
    client.post("/api/auto/messages", json={"text": "and now"})
    settle(client)
    assert second.seeded == [("user", "hello"), ("assistant", "Hi.")]


def test_a_model_without_server_side_fallback_is_asked_without_it():
    chat = AnthropicChat("claude-haiku-5-5", "s", TOOLS)
    assert "fallbacks" not in chat.params() and "betas" not in chat.params()


def test_after_a_fallback_only_the_declined_models_text_goes_back():
    class Block:
        def __init__(self, type: str, **fields) -> None:
            self.type = type
            self.fields = fields
            for key, value in fields.items():
                setattr(self, key, value)

        def model_dump(self, **kwargs) -> dict:
            return {"type": self.type, **self.fields}

    blocks = [
        Block("thinking", thinking="", signature="a"),
        Block("text", text="partial"),
        Block("tool_use", id="early", name="list_jobs", input={}),
        Block("fallback", to={"model": "claude-opus-4-8"}),
        Block("text", text="go on"),
        Block("tool_use", id="late", name="list_jobs", input={}),
    ]
    sent, uses = echo(blocks)
    assert [block["type"] for block in sent] == ["text", "fallback", "text", "tool_use"]
    assert [block.id for block in uses] == ["late"]
    sent, uses = echo(blocks[:3])
    assert len(sent) == 3 and [block.id for block in uses] == ["early"]


# --- the OpenAI-compatible provider ----------------------------------------------------


def test_the_openai_provider_round_trips_a_tool_call(client):
    bodies: list[dict] = []
    headers: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        headers.append(dict(request.headers))
        if len(bodies) == 1:
            calls = [
                {"id": "call_1", "type": "function", "function": {"name": "list_jobs", "arguments": "{}"}},
                {"id": "call_2", "type": "function", "function": {"name": "list_jobs", "arguments": "{oops"}},
            ]
            return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": calls}, "finish_reason": "tool_calls"}]})
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "None yet."}, "finish_reason": "stop"}]})

    def make(agent, choice):
        return ChatSession(OpenAIChat(choice.base_url, choice.model, None, SYSTEM_PROMPT, TOOLS, transport=httpx.MockTransport(handler)), agent.max_calls)

    client.agent.factories["openai"] = make
    client.put("/api/auto/settings", json={"provider": "openai", "model": "llama3.1", "base_url": "http://box:11434/v1/"})
    client.post("/api/auto/messages", json={"text": "jobs?"})
    state = settle(client)
    assert roles(state) == ["user", "tool", "tool", "assistant"]
    good, bad = state["entries"][1], state["entries"][2]
    assert not good["error"] and bad["error"] and json.loads(bad["result"]) == {"INVALID_JSON": "{oops"}
    assert bodies[0]["model"] == "llama3.1" and bodies[0]["tool_choice"] == "auto"
    assert bodies[0]["messages"][0] == {"role": "system", "content": SYSTEM_PROMPT}
    assert bodies[0]["tools"][0]["function"]["parameters"] == TOOLS[0].schema
    assert "authorization" not in headers[0]
    after = bodies[1]["messages"]
    assert after[2]["role"] == "assistant" and [call["id"] for call in after[2]["tool_calls"]] == ["call_1", "call_2"]
    assert after[3] == {"role": "tool", "tool_call_id": "call_1", "content": good["result"]}
    assert after[4]["tool_call_id"] == "call_2" and after[4]["content"].startswith("error: ")


def strict_json(text: str):
    """JSON as a browser reads it: no NaN or Infinity."""

    def refuse(constant: str):
        raise ValueError(f"{constant} is not JSON")

    return json.loads(text, parse_constant=refuse)


def test_a_call_with_nan_or_a_lone_surrogate_is_refused_and_the_conversation_still_loads(client):
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        if len(bodies) == 1:
            written = [
                ("save_marker", '{"name": "corner", "x": NaN, "y": 0}'),
                ("plan_plot_job", '{"kind": "drill", "points": [[1e400, 0]], "tool": 1}'),
                ("make_job", '{"filename": "a.svg", "content": "<svg>\\ud800</svg>"}'),
            ]
            calls = [{"id": f"call_{i}", "type": "function", "function": {"name": name, "arguments": arguments}} for i, (name, arguments) in enumerate(written)]
            return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": calls}, "finish_reason": "tool_calls"}]})
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "Those did not read."}, "finish_reason": "stop"}]})

    def make(agent, choice):
        return ChatSession(OpenAIChat(choice.base_url, choice.model, None, SYSTEM_PROMPT, TOOLS, transport=httpx.MockTransport(handler)), agent.max_calls)

    client.agent.factories["openai"] = make
    client.put("/api/auto/settings", json={"provider": "openai", "model": "llama3.1"})
    with client.websocket_connect("/ws") as socket:
        assert socket.receive_json()["type"] == "state"
        assert client.post("/api/auto/messages", json={"text": "a marker, a drill, a drawing"}).status_code == 200
        while True:
            # Every event reads as JSON in the page.
            event = strict_json(socket.receive_text())
            if event["type"] == "auto" and event["entry"] is None and not event["busy"]:
                break
    response = client.get("/api/auto/conversation")
    assert response.status_code == 200, response.text
    state = strict_json(response.text)
    assert roles(state) == ["user", "tool", "tool", "tool", "assistant"], state
    tools = state["entries"][1:4]
    assert all(tool["done"] and tool["error"] for tool in tools)
    assert tools[0]["result"] == "the arguments do not fit save_marker: x: not a finite number"
    assert tools[1]["result"] == "the arguments do not fit plan_plot_job: points/0/0: not a finite number"
    assert tools[2]["result"] == "the arguments do not fit make_job: content: not valid text (an unpaired surrogate)"
    # What the model wrote is shown as text JSON can carry.
    assert tools[0]["arguments"] == {"unreadable": '{"name": "corner", "x": NaN, "y": 0}'}
    assert state["entries"][-1]["text"] == "Those did not read."
    answers = [message for message in bodies[1]["messages"] if message["role"] == "tool"]
    assert [answer["content"] for answer in answers] == ["error: " + tool["result"] for tool in tools]
    assert client.get("/api/markers").json()["markers"] == [] and client.get("/api/jobs").json()["jobs"] == []


def test_the_openai_provider_sends_a_key_only_when_there_is_one_and_needs_a_model():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(401, json={"error": {"message": "bad key"}})

    async def go():
        chat = OpenAIChat("https://api.example/v1", "m", "sk-x", "s", TOOLS, transport=httpx.MockTransport(handler))
        chat.add_user("hi")
        with pytest.raises(ProviderError, match="401: bad key"):
            await chat.reply(lambda text: None)
        assert seen[0].headers["authorization"] == "Bearer sk-x" and str(seen[0].url) == "https://api.example/v1/chat/completions"
        with pytest.raises(ProviderError, match="model"):
            await OpenAIChat("http://x/v1", "", None, "s", TOOLS).reply(lambda text: None)

    asyncio.run(go())


# --- the Claude Code provider ----------------------------------------------------------


def after(argv: list[str], option: str) -> str:
    return argv[argv.index(option) + 1]


def test_the_claude_code_command_line_keeps_it_to_the_spinny_tools():
    argv = command("/opt/bin/claude", "/venv/bin/python", "http://127.0.0.1:8000", "SYSTEM", model="opus", session="s-1")
    assert argv[0] == "/opt/bin/claude" and "--print" in argv
    assert after(argv, "--output-format") == "stream-json" and "--verbose" in argv
    assert after(argv, "--tools") == ""
    assert after(argv, "--allowedTools") == "mcp__spinny__*"
    assert {"Bash", "Edit", "Write", "Read", "WebFetch"} <= set(after(argv, "--disallowedTools").split(","))
    assert after(argv, "--permission-mode") == "dontAsk" and after(argv, "--permission-prompts") == "none"
    assert "--strict-mcp-config" in argv and "--disable-slash-commands" in argv
    assert json.loads(after(argv, "--mcp-config")) == {
        "mcpServers": {"spinny": {"type": "stdio", "command": "/venv/bin/python", "args": ["-m", "spinny_web.mcp_server", "--url", "http://127.0.0.1:8000"]}}
    }
    assert after(argv, "--system-prompt") == "SYSTEM" and after(argv, "--model") == "opus" and after(argv, "--resume") == "s-1"
    first = command("claude", "py", "http://h:1", "S")
    assert "--resume" not in first and "--model" not in first


FAKE_CLAUDE = """#!{python}
import json, os, signal, sys, time
if os.environ.get("FAKE_CLAUDE_DEAF"):
    signal.signal(signal.SIGINT, signal.SIG_IGN)
prompt = sys.stdin.read()
with open(os.environ["FAKE_CLAUDE_LOG"], "a") as log:
    log.write(json.dumps({{"argv": sys.argv[1:], "prompt": prompt, "pid": os.getpid()}}) + "\\n")
def out(event):
    print(json.dumps(event), flush=True)
out({{"type": "system", "subtype": "init", "session_id": "s-1", "mcp_servers": [{{"name": "spinny", "status": "connected"}}]}})
out({{"type": "stream_event", "event": {{"type": "message_start", "message": {{}}}}}})
out({{"type": "stream_event", "event": {{"type": "content_block_start", "index": 0, "content_block": {{"type": "text", "text": ""}}}}}})
out({{"type": "stream_event", "event": {{"type": "content_block_delta", "index": 0, "delta": {{"type": "text_delta", "text": "Looking "}}}}}})
out({{"type": "stream_event", "event": {{"type": "content_block_delta", "index": 0, "delta": {{"type": "text_delta", "text": "now."}}}}}})
out({{"type": "assistant", "message": {{"content": [{{"type": "text", "text": "Looking now."}}]}}}})
if os.environ.get("FAKE_CLAUDE_HANG"):
    out({{"type": "assistant", "message": {{"content": [{{"type": "tool_use", "id": "slow", "name": "mcp__spinny__make_job", "input": {{"filename": "a.svg"}}}}]}}}})
    time.sleep(60)
for i in range(int(os.environ.get("FAKE_CLAUDE_CALLS", "1"))):
    out({{"type": "assistant", "message": {{"content": [{{"type": "tool_use", "id": f"t{{i}}", "name": "mcp__spinny__make_job", "input": {{"filename": "a.svg"}}}}]}}}})
    out({{"type": "user", "message": {{"content": [{{"type": "tool_result", "tool_use_id": f"t{{i}}", "content": [{{"type": "text", "text": "made"}}]}}]}}}})
out({{"type": "assistant", "message": {{"content": [{{"type": "text", "text": "Made it."}}]}}}})
out({{"type": "result", "subtype": "success", "is_error": False, "result": "Made it.", "session_id": "s-1"}})
"""


def fake_claude(tmp_path: Path) -> Path:
    path = tmp_path / "claude"
    path.write_text(FAKE_CLAUDE.format(python=sys.executable))
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def agent_for(tmp_path: Path, which) -> tuple[Agent, list[dict]]:
    events: list[dict] = []
    config: dict = {"auto": {"provider": "claude-code"}}
    agent = Agent(config, lambda: None, events.append, toolbox=lambda: None, api_url="http://127.0.0.1:8000", workdir=tmp_path / "auto", which=which)
    return agent, events


async def turn(agent: Agent, text: str) -> None:
    agent.send(text)
    while agent.busy:
        await asyncio.sleep(0.01)


def test_the_claude_code_provider_reads_its_stream_and_goes_on_with_its_session(tmp_path, monkeypatch):
    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(log))
    script = fake_claude(tmp_path)
    agent, events = agent_for(tmp_path, lambda name: str(script))

    async def go():
        await turn(agent, "make a job")
        await turn(agent, "and again")

    asyncio.run(go())
    state = agent.conversation()
    assert [entry["role"] for entry in state["entries"]] == ["user", "assistant", "tool", "assistant"] * 2
    tool = state["entries"][2]
    assert tool["name"] == "make_job" and tool["arguments"] == {"filename": "a.svg"} and tool["result"] == "made"
    assert tool["changed"] == ["jobs"] and not tool["error"]
    assert state["entries"][1]["text"] == "Looking now." and state["entries"][3]["text"] == "Made it."
    runs = [json.loads(line) for line in log.read_text().splitlines()]
    assert runs[0]["prompt"] == "make a job" and "--resume" not in runs[0]["argv"]
    assert runs[1]["prompt"] == "and again" and after(runs[1]["argv"], "--resume") == "s-1"
    assert all("make a job" not in arg for arg in runs[0]["argv"])
    # The answer streamed before it was done.
    texts = [event["entry"]["text"] for event in events if event["entry"] and event["entry"]["role"] == "assistant" and not event["entry"]["done"]]
    assert texts and texts[0] == "Looking "


def test_the_claude_code_provider_is_stopped_at_the_cap(tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(tmp_path / "log.jsonl"))
    monkeypatch.setenv("FAKE_CLAUDE_CALLS", "5")
    script = fake_claude(tmp_path)
    agent, _ = agent_for(tmp_path, lambda name: str(script))
    agent.max_calls = 2
    asyncio.run(turn(agent, "loop"))
    entries = agent.conversation()["entries"]
    assert [entry["role"] for entry in entries].count("tool") == 2
    assert entries[-1]["role"] == "notice" and "after 2 tool calls" in entries[-1]["text"]


def test_a_stop_ends_the_claude_command_and_the_conversation_goes_on(tmp_path, monkeypatch):
    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(log))
    monkeypatch.setenv("FAKE_CLAUDE_HANG", "1")
    script = fake_claude(tmp_path)
    agent, _ = agent_for(tmp_path, lambda name: str(script))

    async def go():
        agent.send("hang")
        while not any(entry.role == "tool" for entry in agent.entries):
            await asyncio.sleep(0.01)
        started = time.monotonic()
        await agent.stop()
        return time.monotonic() - started

    took = asyncio.run(go())
    entries = agent.conversation()["entries"]
    assert [entry["role"] for entry in entries] == ["user", "assistant", "tool", "notice"] and entries[-1]["text"] == "Stopped."
    # The tool may have run all the same: the page lists the jobs again.
    assert entries[2]["done"] and entries[2]["error"] and entries[2]["result"] == RAN_ON and entries[2]["changed"] == ["jobs"]
    assert not agent.busy and took < 5.0
    pid = json.loads(log.read_text().splitlines()[0])["pid"]
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


def test_a_new_chat_or_a_second_stop_during_a_stop_still_ends_the_claude_command(tmp_path, monkeypatch):
    # A claude that does not end on the interrupt, as the terminate and the
    # kill after it are there for.
    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(log))
    monkeypatch.setenv("FAKE_CLAUDE_HANG", "1")
    monkeypatch.setenv("FAKE_CLAUDE_DEAF", "1")
    script = fake_claude(tmp_path)
    for second in ("clear", "stop", "cancel"):
        log.write_text("")
        agent, _ = agent_for(tmp_path, lambda name: str(script))

        async def go():
            agent.send("hang")
            while not any(entry.role == "tool" for entry in agent.entries):
                await asyncio.sleep(0.01)
            stopping = asyncio.ensure_future(agent.stop())
            await asyncio.sleep(0.5)
            if second == "cancel":
                # As a shutdown cancels what is left.
                agent._task.cancel()
            else:
                await (agent.clear() if second == "clear" else agent.stop())
            await stopping

        pid = None
        try:
            asyncio.run(go())
            pid = json.loads(log.read_text().splitlines()[0])["pid"]
            with pytest.raises(ProcessLookupError):
                os.kill(pid, 0)
            assert not agent.busy
        finally:
            if pid is None and log.read_text().strip():
                pid = json.loads(log.read_text().splitlines()[0])["pid"]
            if pid is not None:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


def test_a_missing_claude_command_is_said_in_the_conversation(tmp_path):
    agent, _ = agent_for(tmp_path, lambda name: None)
    asyncio.run(turn(agent, "hello"))
    entries = agent.conversation()["entries"]
    assert entries[-1]["role"] == "error" and "not on the backend's PATH" in entries[-1]["text"]
    assert not agent.busy


def test_a_claude_code_session_started_part_way_is_told_the_conversation(tmp_path, monkeypatch):
    log = tmp_path / "log.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(log))
    session = ClaudeCodeSession(str(fake_claude(tmp_path)), "http://127.0.0.1:8000", tmp_path / "auto", "", "S", 25, sys.executable)
    session.seed([("user", "hello"), ("assistant", "Hi.")])

    class Quiet:
        calls = 0

        def text(self, snapshot):
            pass

        def end_text(self, final=None):
            pass

        def tool_started(self, name, arguments):
            self.calls += 1
            return Entry(role="tool", name=name)

        def tool_finished(self, entry, outcome: Outcome):
            pass

        def notice(self, text):
            pass

        def error(self, text):
            raise AssertionError(text)

    asyncio.run(session.turn("next", Quiet()))
    asyncio.run(session.turn("after", Quiet()))
    prompts = [json.loads(line)["prompt"] for line in log.read_text().splitlines()]
    assert prompts[0].startswith("The conversation so far") and "Operator: hello" in prompts[0] and "You: Hi." in prompts[0]
    assert prompts[0].endswith("next") and prompts[1] == "after"


def test_the_backend_hands_claude_code_its_own_address(tmp_path, monkeypatch):
    import uvicorn

    from spinny_web import app as app_module

    seen: dict = {}
    monkeypatch.setattr(app_module, "setup_log", lambda *args, **kwargs: None)
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: seen.update(app=app, **kwargs))
    app_module.main(["--host", "0.0.0.0", "--port", "8123", "--data", str(tmp_path)])
    assert seen["app"].state.auto.api_url == "http://127.0.0.1:8123"
    app_module.main(["--host", "192.168.1.20", "--port", "8000", "--data", str(tmp_path)])
    assert seen["app"].state.auto.api_url == "http://192.168.1.20:8000"


def test_the_address_handed_to_claude_code_passes_the_host_check(tmp_path):
    from fastapi.testclient import TestClient

    from spinny_web.app import Backend, create_app

    for url, host in (("http://192.168.1.20:8000", "192.168.1.20:8000"), ("http://[::1]:8000", "[::1]:8000")):
        backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
        app = create_app(backend, frontend=tmp_path / "no-dist", allowed_hosts=["spinny.local"], api_url=url)
        with TestClient(app) as client:
            # The MCP server the Claude Code provider starts calls this address.
            assert client.get("/api/jobs", headers={"host": host}).status_code == 200
            assert client.get("/api/jobs", headers={"host": "spinny.local"}).status_code == 200
            assert client.get("/api/jobs", headers={"host": "evil.example"}).status_code == 400


# --- parts a plain install leaves out -----------------------------------------------


def test_the_anthropic_provider_without_its_package_names_the_extra(client, monkeypatch):
    monkeypatch.setitem(sys.modules, "anthropic", None)
    monkeypatch.delitem(sys.modules, "spinny_web.auto_anthropic")
    with pytest.raises(ProviderError, match=r"spinny-web\[auto\]") as raised:
        auto_module._anthropic(client.agent, auto_module.Choice("anthropic", "", ""))
    assert f"{sys.executable} -m pip install 'anthropic>=2'" in str(raised.value)


def test_the_claude_code_provider_without_mcp_names_the_extra(client, monkeypatch):
    real = auto_module.importlib.util.find_spec
    monkeypatch.setattr(auto_module.importlib.util, "find_spec", lambda name, *rest: None if name == "mcp" else real(name, *rest))
    with pytest.raises(ProviderError, match=r"spinny-web\[mcp\]"):
        auto_module._claude_code(client.agent, auto_module.Choice("claude-code", "", ""))


def test_spinny_mcp_without_its_package_says_what_to_install():
    hidden = "import sys, runpy; sys.modules['mcp'] = None; runpy.run_module('spinny_web.mcp_server', run_name='__main__')"
    done = subprocess.run([sys.executable, "-c", hidden], capture_output=True, text=True)
    assert done.returncode == 1 and "spinny-mcp: the mcp package is not installed" in done.stderr
    assert "spinny-web[mcp]" in done.stderr and "Traceback" not in done.stderr
