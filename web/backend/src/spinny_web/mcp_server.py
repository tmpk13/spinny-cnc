"""`spinny-mcp`: the backend's tools for any MCP client, such as Claude Code,
over stdio.

The tools are the registry in `tools.py`, each a call on the backend's
HTTP API at `--url`, so the backend has to be running; none of them moves
the machine. Claude Code takes it as

    claude mcp add spinny -- uv run --directory <repository> spinny-mcp

and the Auto tab's Claude Code provider starts it the same way for every
turn, pointed at the backend that runs the turn.
"""

from __future__ import annotations

import argparse
from typing import Any

import anyio

from . import __version__
from .auto import missing_package
from .tools import GUIDE, TOOLS, Tool, ToolBox

try:
    import mcp_types as types
    from mcp.server import Server
    from mcp.server.stdio import stdio_server
except ModuleNotFoundError as exc:
    raise SystemExit(f"spinny-mcp: {missing_package('mcp', 'mcp')}") from exc

DEFAULT_URL = "http://127.0.0.1:8000"


def describe(tool: Tool) -> types.Tool:
    """A tool as MCP lists it, with the hints a client shows its user."""
    return types.Tool(
        name=tool.name,
        description=tool.description,
        input_schema=tool.schema,
        annotations=types.ToolAnnotations(
            read_only_hint=tool.read_only,
            destructive_hint=tool.destructive,
            open_world_hint=False,
        ),
    )


def build_server(toolbox: ToolBox) -> Server:
    """An MCP server whose tools are the registry's, called through `toolbox`."""

    async def list_tools(ctx: Any, params: types.PaginatedRequestParams | None) -> types.ListToolsResult:
        return types.ListToolsResult(tools=[describe(tool) for tool in TOOLS])

    async def call_tool(ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
        # A refusal is the tool's answer, not a protocol error: the model
        # reads why and can do something else.
        outcome = await toolbox.call(params.name, params.arguments or {})
        return types.CallToolResult(content=[types.TextContent(text=outcome.text)], is_error=outcome.error)

    return Server(
        "spinny",
        version=__version__,
        instructions=GUIDE,
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )


async def serve(url: str) -> None:
    async with ToolBox.over_http(url) as toolbox:
        server = build_server(toolbox)
        async with stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream, server.create_initialization_options())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="spinny-mcp",
        description="The spinny backend's tools for an MCP client, over stdio: make and change jobs, Plot jobs,"
        " markers, pick and place references and CAM jobs, and read the state. No tool moves the machine.",
    )
    parser.add_argument("--url", default=DEFAULT_URL, help=f"the backend's address (default: {DEFAULT_URL})")
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args(argv)
    anyio.run(serve, args.url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
