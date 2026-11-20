# The Auto tab and the MCP server

A language model that makes jobs through the backend's own tools: the
Auto tab's conversation in the backend, and `spinny-mcp` for Claude Code
or any MCP client. Built 2026-11-08 by a subagent in a worktree and
merged; no provider has been run against a real model yet (no key here,
the `claude` CLI only against a stand-in script).

## The boundary

- One registry (`spinny_web.tools`, 30 tools after the merge) of thin
  httpx calls on the backend's HTTP API, so a tool can do nothing the API
  does not allow. Each names its routes; `RouteGuard` answers 403 to any
  other request before it leaves the client. `test_tools.py` keeps its
  own list of routes that move nothing and a list of forbidden ones (jog,
  goto, home, run, laser, spindle, probe, cameras, device moves, settings
  and file writes, `/api/auto/messages`), both checked to exist in the app,
  and walks every tool against a recording transport. A tool needing a new
  route fails that test until the route is added to the list by hand
  (combine was, 2026-11-08).
- Data deletions are in: `delete_job` (its description limits it to a job
  the operator asks to delete or one the model made by mistake),
  `replace_job`, `delete_marker`, `drop_placement_references`; flagged
  destructive for MCP clients. `GET /api/settings` is not a tool, because
  it talks to the controller.
- The Auto tab's calls go in-process (`httpx.ASGITransport`), with no
  Origin header, so OriginGuard lets them through as it does scripts; the
  new POST, PUT and DELETE routes refuse a foreign Origin. With
  `--allowed-host` set, the in-process calls and `spinny-mcp` arrive with
  Host 127.0.0.1 and were refused, so `create_app` always adds 127.0.0.1
  and localhost: a page from elsewhere cannot send those as its host,
  which is all the host check is for.
- A turn makes at most 25 tool calls; a stop or the cap still answers
  every call the model asked for, so its history stays valid.

## Providers

- `anthropic`: the official SDK (the claude-api skill asks for it over
  plain httpx), streamed, adaptive thinking, effort medium, server-side
  model fallback on for claude-opus-5-5, claude-opus-5, claude-fable-5-1
  and claude-sonnet-5-5 (`FALLBACK_MODELS` in auto_anthropic.py; the skill
  says to enable it and tell the user). Key from `ANTHROPIC_API_KEY`. With
  no credentials the SDK raises a plain `TypeError("Could not resolve
  authentication method...")` at request time, not an AnthropicError: the
  provider translates it.
- `openai`: any OpenAI-compatible endpoint, not streamed (servers differ
  most in how they stream tool calls), one request per answer.
- `claude-code`: the CLI per turn. The variadic options (`--allowedTools`,
  `--disallowedTools`, `--mcp-config`, `--tools`) would swallow a trailing
  prompt, so the prompt goes on stdin; stream-json needs `--verbose`;
  `--tools ""` removes every built-in tool; `--permission-mode dontAsk`
  with `--permission-prompts none` refuses anything not allowed; the allow
  rule is `mcp__spinny__*`. SIGTERM leaves the turn unfinished in the
  session (exit 143) and SIGINT ends it cleanly, so a stop sends SIGINT,
  then SIGTERM, then SIGKILL to the process group. The CLI docs say
  `--bare` becomes the default for `-p`; bare mode never reads OAuth
  logins, so this provider would then need `ANTHROPIC_API_KEY`. Flags from
  `claude --help` 2.1.319: watch the first real run.
- Keys never pass through the page: the settings route says only whether
  each is present. Provider, model and base URL live in config.json under
  `auto`.

## Packages

`mcp` 2.3.0 and `anthropic` 2.6.0 run on `httpx2`, a package apart from
`httpx`: SDK tests use `httpx2.MockTransport`. mcp 2.x differs from 1.x:
`Server(name, on_list_tools=..., on_call_tool=...)`, snake_case types
from `mcp_types`, `mcp.Client(server)` for in-process tests.

## The page

`.labeled` sets `display: flex`, which beats the `hidden` attribute: hide
those with the `hidden` class. The mock's `mock` provider answers by
listing the jobs (one read-only tool) and exists only in the page mock.
In a worktree under the scratchpad, the uv workspace's
`../kicad-to-gcode` path does not resolve; the agent linked one beside it.

## The host check and the address handed to spinny-mcp (2026-11-09)

create_app takes the host of the address handed to spinny-mcp (the bound
one when the backend listens on one address) past TrustedHostMiddleware,
parsed with Starlette's own parse_host_header (it keeps IPv6 brackets).
With --host 192.168.1.20 --allowed-host spinny.local every Claude Code
tool call had answered 400. A browser sends that address as the host
only for a page this server itself served.

## Turns that fail, stop or are declined (2026-11-09)

- The tool box refuses arguments holding NaN, an infinity (1e400 parses
  as one) or an unpaired surrogate before the schema check (spinny-mcp
  too): such a call made every conversation route answer 500. A turn
  that fails inside a call closes that call's line and tells the model
  the turn failed, not that the operator stopped it. An unpaired
  surrogate in the model's text, not its arguments, can still break the
  conversation over the OpenAI-compatible provider: not fixed yet.
- A stop waits up to 5 s (`STOP_WAIT`) for the call under way and tells
  the model and the page what it did; one still running is answered
  'stopped while it ran: it may have taken effect', listing what its tool
  changes so the page reloads the jobs. A turn is cancelled only once,
  so a second Stop or New chat waits for the first, and the claude
  command's SIGINT, SIGTERM and SIGKILL run to the end.
- A declined turn is taken out of the provider's history (Anthropic and
  OpenAI); if its tools had changed something, the next message starts
  with a backend note naming them. The calls of an answer stopped at the
  context window are answered as not run.

## Plugins and bug reports in the tool boundary (2026-11-13)

- New tools: list_plugins and read_plugin (read-only), write_plugin
  (changes plugins, always leaves the plugin off; its description carries
  the host interface), delete_plugin (destructive). 34 tools now.
- ALLOWED gains the four plugin routes; FORBIDDEN gains
  PUT /api/plugins/{id}/enabled, POST /api/reports and
  PUT /api/reports/settings: no tool can turn a plugin on, send a report
  or change where reports go. GUIDE (the system prompt and the MCP
  instructions) says what plugins are and that only the operator turns
  one on, in the Plugins tab.

## Auto looks again (2026-11-20)

Auto searches with the top camera once in every run before it compares a
place found or takes it: the backend keeps a place found until the next
search, so after one board was placed and the next put in, Auto compared
the old board's place with the references without a picture, and Run
would have placed the new board where the old one lay. It searches even
right after a Search by hand; a choice the user may correct.
