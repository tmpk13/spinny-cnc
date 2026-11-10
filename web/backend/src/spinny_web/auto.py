"""The Auto tab: a conversation with a language model that works through the
tools of `tools.py`.

One conversation per backend, kept in memory. A turn runs as an asyncio
task in the server's loop: what the model writes streams to the page as
`auto` events on the websocket, every tool call goes into the app itself
(nothing listens on a new port, and the calls pass the same guards a
page's do), and a stop cancels the task. A turn makes at most
`MAX_TOOL_CALLS` calls, so a model that loops ends.

The provider is picked in the tab and kept in the config: the Anthropic
API, any OpenAI-compatible endpoint, or the `claude` command (Claude Code)
with the tools served to it by `spinny-mcp`. Keys stay in the backend's
environment; the settings say only whether each is there.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import re
import shutil
import sys
import time
from collections.abc import Callable, Coroutine, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel

from .log import log
from .tools import BY_NAME, GUIDE, TOOLS, Outcome, ToolBox, sendable, unfit

# A turn's tool calls at most: past it the turn ends, and the model is told
# why for the calls it asked for and did not get.
MAX_TOOL_CALLS = 25
# How long a stop waits for the tool call under way to end, s. A stop does
# not end the call in the backend (a route's work goes on in a thread of its
# own and keeps what it makes), so what came of it is told rather than that
# it did not run.
STOP_WAIT = 5.0
# What a call still running after that wait is answered, and shown as.
RAN_ON = (
    "stopped while it ran: it may have taken effect all the same, so look"
    " (list_jobs, list_markers, get_placement) before doing it again"
)
# The longest message the operator may send, characters.
MAX_MESSAGE = 20000
# Entries kept; the oldest go first.
MAX_ENTRIES = 1000
# How often an answer being written is sent to the page, s: the last part
# always is.
TEXT_INTERVAL = 0.1

ANTHROPIC, OPENAI, CLAUDE_CODE = "anthropic", "openai", "claude-code"
PROVIDERS = (ANTHROPIC, OPENAI, CLAUDE_CODE)
LABELS = {ANTHROPIC: "Anthropic API", OPENAI: "OpenAI-compatible", CLAUDE_CODE: "Claude Code"}
# The model a provider uses when none is typed: the Anthropic API's
# current Opus; an OpenAI-compatible server has no name every server
# knows, and Claude Code picks its own.
DEFAULT_MODELS = {ANTHROPIC: "claude-opus-5-5", OPENAI: "", CLAUDE_CODE: ""}
KEYS = {ANTHROPIC: "ANTHROPIC_API_KEY", OPENAI: "OPENAI_API_KEY"}
# A local ollama: it needs no key, and answers at this address.
DEFAULT_BASE_URL = "http://localhost:11434/v1"
MODEL = re.compile(r"^[A-Za-z0-9._:/@+-]{0,200}$")
URL = re.compile(r"^https?://[^\s/?#]+[^\s]{0,500}$")

SYSTEM_PROMPT = (
    "You are the Auto tab of the page that drives the spinny machine: the operator types to you there, and"
    " you work through the tools.\n\n"
    + GUIDE
    + "\nKeep answers short and plain: the operator reads them beside the machine. When a request needs a"
    " number only the operator knows (a power that cuts their material, a place on the pick and place"
    " device), ask for it rather than guess.\n"
)


class AutoBusy(Exception):
    """A turn is under way."""


class ProviderError(Exception):
    """What a provider could not do, in words for the operator."""


def missing_package(package: str, extra: str) -> str:
    """What to install for a part a plain install leaves out: `package`,
    which the spinny-web extra `extra` brings in."""
    return (
        f"the {package} package is not installed (a plain install leaves it out): install spinny-web[{extra}],"
        f" or in a release bundle run {sys.executable} -m pip install '{package}>=2'"
    )


class AutoSettingsBody(BaseModel):
    provider: str | None = None
    # The model of `provider` (or of the provider in use): empty for the
    # provider's own default.
    model: str | None = None
    base_url: str | None = None


class AutoMessageBody(BaseModel):
    # Checked by the agent, which says what is wrong with it.
    text: str


@dataclass
class Call:
    """A tool call a model asked for; `arguments` is None when what it
    wrote does not read as JSON, which is then in `raw`."""

    id: str
    name: str
    arguments: dict | None
    raw: str | None = None


@dataclass
class Reply:
    """One answer of a model: its text, the calls it asks for, and why it
    stopped: `end`, `tool_use`, `max_tokens`, `refusal` or `context`. The
    calls are those the provider's history holds, each to be answered; a
    declined answer leaves the history, and its calls with it."""

    text: str
    calls: list[Call]
    stop: str
    note: str | None = None


class Chat(Protocol):
    """A provider that answers one message at a time and leaves the tool
    calls to the loop here: the Anthropic API, an OpenAI-compatible one."""

    def seed(self, turns: list[tuple[str, str]]) -> None: ...

    def add_user(self, text: str) -> None: ...

    async def reply(self, on_text: Callable[[str], None]) -> Reply: ...

    def add_results(self, results: list[tuple[Call, str, bool]]) -> None: ...


class Session(Protocol):
    """A provider's side of the conversation: it takes the operator's
    message and reports what happens to the sink."""

    def seed(self, turns: list[tuple[str, str]]) -> None: ...

    async def turn(self, text: str, sink: Sink) -> None: ...


@dataclass
class Entry:
    """One line of the conversation as the page shows it: what the operator
    sent, what the model wrote, a tool call with its result, or a notice or
    an error of the backend's own."""

    role: str
    text: str = ""
    done: bool = True
    name: str | None = None
    arguments: Any = None
    result: str | None = None
    error: bool = False
    changed: list[str] = field(default_factory=list)
    id: int = 0
    sent: float = field(default=0.0, repr=False)
    # An operator's message the model declined: the provider has taken its
    # turn out of its history, and a provider picked later is not told it.
    declined: bool = field(default=False, repr=False)

    def to_dict(self) -> dict:
        out: dict[str, Any] = {"id": self.id, "role": self.role, "text": self.text, "done": self.done}
        if self.role == "tool":
            out.update(name=self.name, arguments=self.arguments, result=self.result, error=self.error, changed=list(self.changed))
        return out


class ChatSession:
    """The tool loop for a `Chat`: the model answers, the tools it asks for
    are called, their results go back, until it answers without a call, it
    stops for a reason of its own, or the turn's calls run out. Every call
    a model asked for is answered, a stop included, so the history stays
    one the provider takes."""

    def __init__(self, chat: Chat, max_calls: int = MAX_TOOL_CALLS) -> None:
        self.chat = chat
        self.max_calls = max_calls
        # Tools that made or changed something in turns the model declined:
        # those turns left the history, so the next message says so.
        self._carried: list[str] = []

    def seed(self, turns: list[tuple[str, str]]) -> None:
        self.chat.seed(turns)

    def _not_run(self, calls: list[Call], why: str) -> None:
        """Answers calls of an answer that stopped short, none of them run:
        a call the history holds unanswered makes the provider refuse every
        later request."""
        if calls:
            self.chat.add_results([(call, f"not run: {why}", True) for call in calls])

    async def turn(self, text: str, sink: Sink) -> None:
        # Told again should this turn be declined too.
        made, self._carried = self._carried, []
        self.chat.add_user(_carried_note(made) + text)
        while True:
            reply = await self.chat.reply(sink.text)
            sink.end_text(reply.text)
            if reply.stop == "refusal":
                self._not_run(reply.calls, "the answer was declined")
                said = f" ({reply.note})" if reply.note else ""
                sink.declined(f"The model declined this{said}: put it another way, or start a new chat.")
                self._carried = made
                return
            if reply.stop == "context":
                # Cut off at the model's window, as one at its length limit.
                self._not_run(reply.calls, "the answer reached the model's context window before this call was whole")
                sink.notice("The conversation is longer than the model takes: start a new chat.")
                return
            if not reply.calls:
                if reply.stop == "max_tokens":
                    sink.notice("The answer was cut off at its length limit.")
                return
            if reply.stop == "max_tokens":
                # A call cut off part way can read as a whole one with
                # arguments missing: none of them runs.
                self._not_run(reply.calls, "the answer was cut off before this call was whole")
                sink.notice("The answer was cut off at its length limit before its tool calls were whole: nothing was run.")
                return
            results: list[tuple[Call, str, bool]] = []
            capped = False
            current: tuple[Call, Entry] | None = None
            why, under_way = "the operator stopped the turn", RAN_ON
            try:
                for call in reply.calls:
                    if sink.calls >= self.max_calls:
                        results.append((call, f"not run: a turn makes at most {self.max_calls} tool calls", True))
                        capped = True
                        continue
                    shown = call.arguments if call.arguments is not None else {"unreadable": call.raw}
                    entry = sink.tool_started(call.name, shown)
                    current = (call, entry)
                    if call.arguments is None:
                        outcome = Outcome(json.dumps({"INVALID_JSON": call.raw}), True)
                    else:
                        outcome = await sink.call(entry, call.name, call.arguments)
                    sink.tool_finished(entry, outcome)
                    results.append((call, outcome.text, outcome.error))
                    current = None
                    tool = BY_NAME.get(call.name)
                    if tool is not None and not tool.read_only and not outcome.error:
                        made.append(call.name)
            except Exception as exc:
                why, under_way = f"the turn failed: {exc!r}", f"failed: {exc!r}"
                raise
            finally:
                if current is not None:
                    # The call under way: what came of it when it ended in
                    # the stop's wait, else that it may yet take effect.
                    ongoing, line = current
                    results.append((ongoing, line.result or "", line.error) if line.done else (ongoing, under_way, True))
                answered = {id(call) for call, _, _ in results}
                results += [(call, f"not run: {why}", True) for call in reply.calls if id(call) not in answered]
                self.chat.add_results(results)
            if capped:
                sink.notice(f"Stopped after {self.max_calls} tool calls in one turn: send a message to go on.")
                return


def _carried_note(made: list[str]) -> str:
    """What declined turns had already done, put before the next message."""
    if not made:
        return ""
    return (
        "(From the backend: an earlier message was declined and is left out of this conversation. Tool calls"
        f" made for it had already run, and what they made or changed stands: {', '.join(made)}. Look before"
        " doing any of it again.)\n\n"
    )


class Sink:
    """What a turn reports to the conversation, and the tool calls it makes
    in-process; a provider that runs its own tools (Claude Code) only
    reports them."""

    def __init__(self, agent: Agent, asked: Entry | None = None) -> None:
        self.agent = agent
        # The operator's message the turn answers.
        self.asked = asked
        self.calls = 0
        self._text: Entry | None = None
        self._toolbox: ToolBox | None = None
        # The call under way when the turn was stopped that ran on past the
        # wait: its line shows what came of it once it ends.
        self._ran_on: tuple[Entry, asyncio.Future] | None = None

    def text(self, snapshot: str) -> None:
        """The answer being written, all of it so far."""
        if self._text is None:
            if snapshot.strip():
                self._text = self.agent._add(Entry(role="assistant", text=snapshot, done=False))
            return
        self._text.text = snapshot
        self.agent._touch(self._text)

    def end_text(self, final: str | None = None) -> None:
        """The answer is written; `final` is its whole text when known."""
        entry, self._text = self._text, None
        if final is not None and final.strip():
            if entry is None:
                self.agent._add(Entry(role="assistant", text=final))
                return
            entry.text = final
        if entry is not None:
            entry.done = True
            self.agent._update(entry)

    def tool_started(self, name: str, arguments: Any) -> Entry:
        self.end_text()
        self.calls += 1
        if unfit(arguments) is not None:
            # A number JSON cannot carry (NaN, an infinity) or text that is
            # not Unicode would keep the conversation from being sent at
            # all: the call is kept as the text JSON makes of it.
            arguments = {"unreadable": json.dumps(arguments, ensure_ascii=True)}
        return self.agent._add(Entry(role="tool", name=sendable(name), arguments=arguments, done=False))

    def tool_finished(self, entry: Entry, outcome: Outcome) -> None:
        entry.result = outcome.text
        entry.error = outcome.error
        entry.changed = list(outcome.changed)
        entry.done = True
        self.agent._update(entry)

    async def call(self, entry: Entry, name: str, arguments: Any) -> Outcome:
        """The call made in the backend, shown by `entry`. On a stop the
        call is given STOP_WAIT to end, and its line ends with what it did;
        one still running then is left to end on its own."""
        if self._toolbox is None:
            self._toolbox = self.agent.toolbox()
        running = asyncio.ensure_future(self._toolbox.call(name, arguments))
        try:
            return await asyncio.shield(running)
        except asyncio.CancelledError:
            self._ran_on = (entry, running)
            await asyncio.wait({running}, timeout=STOP_WAIT)
            if running.done():
                self._ran_on = None
                self.tool_finished(entry, _outcome(running))
            raise

    def notice(self, text: str) -> None:
        self.end_text()
        self.agent._add(Entry(role="notice", text=text))

    def declined(self, text: str) -> None:
        """The model declined the operator's message, which the provider has
        taken out of its history: said, and kept from a provider picked
        later."""
        if self.asked is not None:
            self.asked.declined = True
        self.notice(text)

    def error(self, text: str) -> None:
        self.end_text()
        self.agent._add(Entry(role="error", text=text))

    def _close(self, result: str, changes: bool = False) -> None:
        """Whatever was under way is done: an answer with what it had
        written, a call with `result` and, with `changes`, as having
        changed what its tool changes."""
        self._text = None
        for entry in self.agent.entries:
            if not entry.done:
                entry.done = True
                if entry.role == "tool":
                    entry.result = result
                    entry.error = True
                    tool = BY_NAME.get(entry.name or "") if changes else None
                    if tool is not None:
                        entry.changed = list(tool.changes)
                self.agent._update(entry)

    def stopped(self) -> None:
        """The operator stopped the turn. A call under way may have taken
        effect all the same, since the backend goes on with what it was
        asked: it is shown so, and the page shows again what its tool
        changes."""
        self._close(RAN_ON, changes=True)
        self.agent._add(Entry(role="notice", text="Stopped."))

    def failed(self, text: str) -> None:
        """The turn ended on an error: a call under way ends with it."""
        self._close(text)
        self.agent._add(Entry(role="error", text=text))

    async def close(self) -> None:
        toolbox, self._toolbox = self._toolbox, None
        ran_on, self._ran_on = self._ran_on, None
        if ran_on is not None:
            # The call that ran on past the stop still uses the tool box.
            self.agent._keep(self._settle(*ran_on, toolbox))
        elif toolbox is not None:
            await toolbox.aclose()

    async def _settle(self, entry: Entry, running: asyncio.Future, toolbox: ToolBox | None) -> None:
        """Sees a call that ran on past a stop to its end, closes the tool
        box it used, and shows what came of the call while the conversation
        still holds its line."""
        try:
            await asyncio.wait({running})
        except asyncio.CancelledError:
            running.cancel()
            raise
        finally:
            if toolbox is not None:
                await toolbox.aclose()
        if any(kept is entry for kept in self.agent.entries):
            outcome = _outcome(running)
            self.tool_finished(entry, Outcome(f"after the stop: {outcome.text}", outcome.error, outcome.changed))


def _outcome(done: asyncio.Future) -> Outcome:
    """What a call that has ended came to."""
    if done.cancelled():
        return Outcome("not run: the call was cancelled", True)
    error = done.exception()
    return done.result() if error is None else Outcome(f"failed: {error!r}", True)


@dataclass(frozen=True)
class Choice:
    """The provider, model and base URL the next turn uses."""

    provider: str
    model: str
    base_url: str

    @property
    def model_or_default(self) -> str:
        return self.model or DEFAULT_MODELS[self.provider]

    @property
    def key(self) -> tuple[str, str, str]:
        """What a provider's session is made for: another of these starts
        another session. The base URL counts only where it is used."""
        return (self.provider, self.model, self.base_url if self.provider == OPENAI else "")


SessionFactory = Callable[["Agent", Choice], Session]


def _anthropic(agent: Agent, choice: Choice) -> Session:
    try:
        from .auto_anthropic import AnthropicChat
    except ModuleNotFoundError as exc:
        if exc.name != "anthropic" and not (exc.name or "").startswith("anthropic."):
            raise
        raise ProviderError(missing_package("anthropic", "auto")) from exc

    return ChatSession(AnthropicChat(choice.model_or_default, SYSTEM_PROMPT, TOOLS), agent.max_calls)


def _openai(agent: Agent, choice: Choice) -> Session:
    from .auto_openai import OpenAIChat

    key = agent.env.get(KEYS[OPENAI]) or None
    return ChatSession(OpenAIChat(choice.base_url, choice.model_or_default, key, SYSTEM_PROMPT, TOOLS), agent.max_calls)


def _claude_code(agent: Agent, choice: Choice) -> Session:
    from .auto_claude import ClaudeCodeSession

    # Claude Code reaches the tools through spinny-mcp, run with this Python.
    if importlib.util.find_spec("mcp") is None:
        raise ProviderError(missing_package("mcp", "mcp"))

    return ClaudeCodeSession(
        binary=agent.which("claude"),
        api_url=agent.api_url,
        workdir=agent.workdir / "claude-code",
        model=choice.model_or_default,
        system=SYSTEM_PROMPT,
        max_calls=agent.max_calls,
        python=sys.executable,
    )


FACTORIES: dict[str, SessionFactory] = {ANTHROPIC: _anthropic, OPENAI: _openai, CLAUDE_CODE: _claude_code}


class Agent:
    """The conversation, the turn under way, and the provider settings."""

    def __init__(
        self,
        config: dict,
        save_config: Callable[[], None],
        publish: Callable[[dict], None],
        toolbox: Callable[[], ToolBox],
        api_url: str,
        workdir: Path,
        env: Mapping[str, str] | None = None,
        which: Callable[[str], str | None] = shutil.which,
        factories: Mapping[str, SessionFactory] | None = None,
        max_calls: int = MAX_TOOL_CALLS,
    ) -> None:
        self.config = config
        self._save_config = save_config
        self._send = publish
        self.toolbox = toolbox
        self.api_url = api_url
        self.workdir = workdir
        self.env = env if env is not None else os.environ
        self.which = which
        self.factories = dict(factories) if factories is not None else dict(FACTORIES)
        self.max_calls = max_calls
        self.entries: list[Entry] = []
        self._next_id = 1
        self._busy = False
        self._task: asyncio.Task | None = None
        self._session: Session | None = None
        self._session_key: tuple[str, str, str] | None = None
        # Calls that ran on past a stop, each seen to its end.
        self._settling: set[asyncio.Task] = set()

    # --- settings ---------------------------------------------------------------

    def _stored(self) -> dict:
        value = self.config.get("auto")
        return value if isinstance(value, dict) else {}

    def _model_of(self, provider: str) -> str:
        models = self._stored().get("models")
        model = models.get(provider) if isinstance(models, dict) else None
        return model if isinstance(model, str) and MODEL.match(model) else ""

    def choice(self) -> Choice:
        stored = self._stored()
        provider = stored.get("provider")
        if provider not in PROVIDERS:
            provider = ANTHROPIC
        base_url = stored.get("base_url")
        if not (isinstance(base_url, str) and URL.match(base_url)):
            base_url = DEFAULT_BASE_URL
        return Choice(provider, self._model_of(provider), base_url)

    def _provider_state(self, provider: str) -> dict:
        state: dict[str, Any] = {"id": provider, "label": LABELS[provider], "default_model": DEFAULT_MODELS[provider]}
        if provider == CLAUDE_CODE:
            path = self.which("claude")
            state.update(key_name=None, key_present=None, ready=path is not None)
            state["note"] = f"runs {path}" if path else "the claude command is not on the backend's PATH"
            return state
        key = KEYS[provider]
        present = bool(self.env.get(key))
        if provider == ANTHROPIC:
            # The SDK also takes a bearer token or a login profile, so a
            # missing key is said, not refused.
            present = present or bool(self.env.get("ANTHROPIC_AUTH_TOKEN"))
            note = None if present else f"{key} is not set where the backend runs"
        else:
            note = None if present else f"{key} is not set: a local server such as ollama needs none"
        state.update(key_name=key, key_present=present, ready=True, note=note)
        return state

    def settings(self) -> dict:
        choice = self.choice()
        return {
            "provider": choice.provider,
            "model": choice.model,
            "base_url": choice.base_url,
            "models": {provider: self._model_of(provider) for provider in PROVIDERS},
            "providers": [self._provider_state(provider) for provider in PROVIDERS],
            "max_tool_calls": self.max_calls,
        }

    def update_settings(self, provider: str | None = None, model: str | None = None, base_url: str | None = None) -> dict:
        """Keeps the provider, its model and the base URL; the next turn
        takes them. Refuses what does not read before keeping any of it."""
        stored = dict(self._stored())
        if provider is not None and provider not in PROVIDERS:
            raise ValueError(f"provider must be one of {', '.join(PROVIDERS)}")
        if model is not None:
            model = model.strip()
            if not MODEL.match(model):
                raise ValueError("a model's name is up to 200 letters, digits and . _ : / @ + -")
        if base_url is not None:
            base_url = base_url.strip()
            if base_url and not URL.match(base_url):
                raise ValueError("the base URL is http:// or https:// and a host, such as http://localhost:11434/v1")
        if provider is not None:
            stored["provider"] = provider
        if model is not None:
            target = provider or self.choice().provider
            models = dict(stored.get("models") or {})
            models[target] = model
            stored["models"] = models
        if base_url is not None:
            stored["base_url"] = base_url or DEFAULT_BASE_URL
        self.config["auto"] = stored
        self._save_config()
        return self.settings()

    # --- the conversation ---------------------------------------------------------

    @property
    def busy(self) -> bool:
        return self._busy

    def conversation(self) -> dict:
        return {"entries": [entry.to_dict() for entry in self.entries], "busy": self._busy}

    def _publish(self, entry: Entry | None, cleared: bool = False) -> None:
        if entry is not None:
            entry.sent = time.monotonic()
        self._send({"type": "auto", "entry": entry.to_dict() if entry is not None else None, "busy": self._busy, "cleared": cleared})

    def _add(self, entry: Entry) -> Entry:
        entry.id = self._next_id
        self._next_id += 1
        self.entries.append(entry)
        if len(self.entries) > MAX_ENTRIES:
            del self.entries[: len(self.entries) - MAX_ENTRIES]
        self._publish(entry)
        return entry

    def _update(self, entry: Entry) -> None:
        self._publish(entry)

    def _touch(self, entry: Entry) -> None:
        if time.monotonic() - entry.sent >= TEXT_INTERVAL:
            self._publish(entry)

    def _turns(self) -> list[tuple[str, str]]:
        """The conversation so far as plain turns, for a provider that
        starts in the middle of it. A turn the model declined is left out,
        as the provider that declined it left it out of its own history."""
        turns: list[tuple[str, str]] = []
        declined = False
        for entry in self.entries:
            if entry.role == "user":
                declined = entry.declined
            if not declined and entry.role in ("user", "assistant") and entry.text.strip():
                turns.append((entry.role, entry.text))
        return turns

    def _session_for(self, earlier: list[tuple[str, str]]) -> Session:
        choice = self.choice()
        if self._session is None or self._session_key != choice.key:
            session = self.factories[choice.provider](self, choice)
            session.seed(earlier)
            self._session, self._session_key = session, choice.key
        return self._session

    def send(self, text: str) -> dict:
        """Starts a turn with the operator's message; answers at once."""
        text = text.strip()
        if not text:
            raise ValueError("the message is empty")
        if len(text) > MAX_MESSAGE:
            raise ValueError(f"a message is at most {MAX_MESSAGE} characters")
        if self._busy:
            raise AutoBusy("a turn is under way: wait for it, or stop it")
        earlier = self._turns()
        self._busy = True
        asked = self._add(Entry(role="user", text=text))
        self._task = asyncio.get_running_loop().create_task(self._run(text, earlier, asked))
        return self.conversation()

    async def _run(self, text: str, earlier: list[tuple[str, str]], asked: Entry) -> None:
        sink = Sink(self, asked)
        try:
            await self._session_for(earlier).turn(text, sink)
        except asyncio.CancelledError:
            sink.stopped()
            raise
        except ProviderError as exc:
            sink.failed(str(exc))
        except Exception as exc:
            log.exception("auto: the turn failed")
            sink.failed(f"the turn failed: {exc!r}")
        finally:
            sink.end_text()
            await sink.close()
            self._busy = False
            self._task = None
            self._publish(None)

    async def stop(self) -> dict:
        task = self._task
        if task is not None and not task.done():
            # Cancelled once: a second stop, or a new chat during the first,
            # waits for that one to end, which a second cancel would cut
            # short (the wait for a call under way, the claude command's
            # interrupt, terminate and kill).
            if not task.cancelling():
                task.cancel()
            await asyncio.wait({task})
        return self.conversation()

    async def clear(self) -> dict:
        """A new chat: the turn under way stopped, the entries and the
        provider's history gone."""
        await self.stop()
        self.entries = []
        self._session = None
        self._session_key = None
        self._publish(None, cleared=True)
        return self.conversation()

    def _keep(self, work: Coroutine[Any, Any, None]) -> None:
        task = asyncio.ensure_future(work)
        self._settling.add(task)
        task.add_done_callback(self._settling.discard)

    async def shutdown(self) -> None:
        await self.stop()
        for task in list(self._settling):
            task.cancel()
        if self._settling:
            await asyncio.wait(set(self._settling))
