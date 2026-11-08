"""The Auto tab's Claude Code provider: the `claude` command run once per
turn in print mode, reporting as stream-json.

Its only tools are those `spinny-mcp` serves, started by the command for
the turn and pointed at this backend's URL: every built-in tool (files,
shell, the web, agents) is taken away and refused by name, the MCP servers
of the operator's own configuration are left out, and anything not
allowed is refused without a prompt, since nobody is there to answer one.
The command keeps its own history: a turn after the first continues its
session. The message goes in on stdin, so it never shows in a process list
and never meets an option that takes several values.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .auto import Entry, ProviderError, Sink
from .tools import BY_NAME, Outcome

SERVER = "spinny"
# What Claude Code calls a tool of an MCP server.
PREFIX = f"mcp__{SERVER}__"
# The built-in tools, refused by name besides being taken away.
DENIED = ("Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "Skill")
# How long the command has to end its turn on an interrupt, and then to
# end at all on a terminate, before it is killed, s.
INTERRUPT_WAIT = 2.0
KILL_WAIT = 3.0
# The longest line of its output read, bytes: a tool's answer is in one.
LINE_LIMIT = 1 << 24


def mcp_config(python: str, api_url: str) -> dict:
    return {"mcpServers": {SERVER: {"type": "stdio", "command": python, "args": ["-m", "spinny_web.mcp_server", "--url", api_url]}}}


def command(binary: str, python: str, api_url: str, system: str, model: str = "", session: str | None = None) -> list[str]:
    """The command line of one turn; the message goes on stdin."""
    argv = [
        binary,
        "--print",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--mcp-config", json.dumps(mcp_config(python, api_url)),
        "--strict-mcp-config",
        "--tools", "",
        "--allowedTools", f"mcp__{SERVER}__*",
        "--disallowedTools", ",".join(DENIED),
        "--permission-mode", "dontAsk",
        "--permission-prompts", "none",
        "--disable-slash-commands",
        "--system-prompt", system,
    ]
    if model:
        argv += ["--model", model]
    if session:
        argv += ["--resume", session]
    return argv


def _flat(content: Any) -> str:
    """A tool result's content as text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(item.get("text", "")) for item in content if isinstance(item, dict) and item.get("type") == "text")
    return json.dumps(content)


class _Reader:
    """One turn's stream-json, line by line, into the conversation."""

    def __init__(self, session: ClaudeCodeSession, sink: Sink) -> None:
        self.session = session
        self.sink = sink
        self.texts: list[str] = []
        self.pending: dict[str, Entry] = {}
        self.result: dict | None = None
        self.capped = False

    def take(self, line: bytes) -> bool:
        """Reads one line; True when the turn has to end here."""
        try:
            event = json.loads(line)
        except ValueError:
            return False
        if not isinstance(event, dict):
            return False
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            self.session.session_id = event.get("session_id") or self.session.session_id
            for server in event.get("mcp_servers") or []:
                if isinstance(server, dict) and server.get("name") == SERVER and server.get("status") != "connected":
                    self.sink.error(f"Claude Code could not start the spinny tools ({server.get('status')}): is the backend at {self.session.api_url}?")
        elif kind == "stream_event":
            self._stream(event.get("event") or {})
        elif kind == "assistant":
            return self._assistant(event.get("message") or {})
        elif kind == "user":
            self._user(event.get("message") or {})
        elif kind == "result":
            self.result = event
            self.session.session_id = event.get("session_id") or self.session.session_id
            if event.get("is_error") or event.get("subtype") not in (None, "success"):
                self.sink.error(f"Claude Code: {event.get('result') or event.get('subtype')}")
        return False

    def _stream(self, raw: dict) -> None:
        kind = raw.get("type")
        if kind == "message_start":
            self.texts = []
        elif kind == "content_block_start" and (raw.get("content_block") or {}).get("type") == "text":
            self.texts.append("")
        elif kind == "content_block_delta" and (raw.get("delta") or {}).get("type") == "text_delta":
            if not self.texts:
                self.texts.append("")
            self.texts[-1] += str(raw["delta"].get("text", ""))
            self.sink.text("\n\n".join(part for part in self.texts if part))

    def _assistant(self, message: dict) -> bool:
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and block.get("text"):
                self.sink.end_text(block["text"])
                self.texts = []
            elif block.get("type") == "tool_use":
                name = str(block.get("name", ""))
                shown = name[len(PREFIX):] if name.startswith(PREFIX) else name
                if self.sink.calls >= self.session.max_calls:
                    self.capped = True
                    return True
                self.pending[str(block.get("id"))] = self.sink.tool_started(shown, block.get("input"))
        return False

    def _user(self, message: dict) -> None:
        content = message.get("content")
        if not isinstance(content, list):
            return
        for block in content:
            if not (isinstance(block, dict) and block.get("type") == "tool_result"):
                continue
            entry = self.pending.pop(str(block.get("tool_use_id")), None)
            if entry is None:
                continue
            error = bool(block.get("is_error"))
            tool = BY_NAME.get(entry.name or "")
            changed = tool.changes if tool is not None and not error else ()
            self.sink.tool_finished(entry, Outcome(_flat(block.get("content")), error, changed))

    def unanswered(self, why: str) -> None:
        for entry in self.pending.values():
            self.sink.tool_finished(entry, Outcome(why, True))
        self.pending.clear()


class ClaudeCodeSession:
    def __init__(
        self,
        binary: str | None,
        api_url: str,
        workdir: Path,
        model: str,
        system: str,
        max_calls: int,
        python: str,
        env: Mapping[str, str] | None = None,
    ) -> None:
        self.binary = binary
        self.api_url = api_url
        # The command's sessions are kept by the directory it runs in: one
        # of the backend's own, the same every turn, away from any project.
        self.workdir = workdir
        self.model = model
        self.system = system
        self.max_calls = max_calls
        self.python = python
        self.env = env
        self.session_id: str | None = None
        self.preface = ""

    def seed(self, turns: list[tuple[str, str]]) -> None:
        """A session that starts part way through the conversation is told
        what was said before it, with its first message."""
        if turns:
            said = "\n\n".join(f"{'Operator' if role == 'user' else 'You'}: {text}" for role, text in turns)
            self.preface = f"The conversation so far, from before this session:\n\n{said}\n\nThe operator's new message:\n\n"

    def argv(self) -> list[str]:
        return command(self.binary or "claude", self.python, self.api_url, self.system, self.model, self.session_id)

    def _environment(self) -> dict[str, str]:
        env = dict(self.env if self.env is not None else os.environ)
        # A backend started from inside a Claude Code session carries its
        # marker; the command run here is a session of its own.
        env.pop("CLAUDECODE", None)
        return env

    async def turn(self, text: str, sink: Sink) -> None:
        if not self.binary:
            raise ProviderError("the claude command is not on the backend's PATH: install Claude Code where the backend runs, or pick another provider")
        prompt = self.preface + text if self.session_id is None else text
        self.workdir.mkdir(parents=True, exist_ok=True)
        try:
            process = await asyncio.create_subprocess_exec(
                *self.argv(),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.workdir,
                env=self._environment(),
                # Its own process group, so a stop ends the MCP server it
                # started along with it.
                start_new_session=True,
                limit=LINE_LIMIT,
            )
        except OSError as exc:
            raise ProviderError(f"could not start {self.binary}: {exc}") from exc
        reader = _Reader(self, sink)
        errors = asyncio.ensure_future(process.stderr.read()) if process.stderr is not None else None
        ended = stopped = False
        try:
            assert process.stdin is not None and process.stdout is not None
            try:
                process.stdin.write(prompt.encode("utf-8"))
                await process.stdin.drain()
                process.stdin.close()
            except (BrokenPipeError, ConnectionResetError):
                pass
            async for line in process.stdout:
                if reader.take(line):
                    break
            else:
                ended = True
        except asyncio.CancelledError:
            # The operator's stop: the calls under way are marked stopped
            # by the agent.
            stopped = True
            raise
        finally:
            await self._end(process, kill=not ended)
            stderr = await self._errors(errors)
            if reader.pending and not stopped:
                reader.unanswered("no answer: Claude Code ended first")
        if reader.capped:
            sink.notice(f"Stopped after {self.max_calls} tool calls in one turn: send a message to go on.")
            return
        if reader.result is None:
            tail = stderr.strip().splitlines()[-3:]
            said = f": {' / '.join(tail)}" if tail else ""
            raise ProviderError(f"claude ended ({process.returncode}) before it answered{said}")
        self.preface = ""

    async def _errors(self, errors: asyncio.Future | None) -> str:
        """What the command wrote to stderr; a child it left behind holding
        the pipe open is not waited for."""
        if errors is None:
            return ""
        try:
            return (await asyncio.wait_for(errors, KILL_WAIT)).decode("utf-8", "replace")
        except TimeoutError:
            return ""

    async def _end(self, process: asyncio.subprocess.Process, kill: bool) -> None:
        if process.returncode is not None:
            return
        if not kill:
            try:
                await asyncio.wait_for(process.wait(), KILL_WAIT)
                return
            except TimeoutError:
                pass
        # An interrupt first: Claude Code then ends the turn under way and
        # keeps it in the session, where a terminate leaves it unfinished.
        for sig, wait in ((signal.SIGINT, INTERRUPT_WAIT), (signal.SIGTERM, KILL_WAIT), (signal.SIGKILL, None)):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(process.wait(), wait)
                return
            except TimeoutError:
                continue
