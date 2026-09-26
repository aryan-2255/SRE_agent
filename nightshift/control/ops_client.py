"""Calls tools on the ops MCP server (used by the watcher; agents call it through TrueForge)."""
import asyncio
import json

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from . import settings


async def call(tool: str, args: dict | None = None, timeout: float = 60) -> dict | list | str:
    headers = {"Authorization": f"Bearer {settings.OPS_MCP_TOKEN}"}
    async with streamablehttp_client(settings.OPS_MCP_URL, headers=headers, timeout=timeout) as (r, w, _):
        async with ClientSession(r, w) as s:
            await s.initialize()
            res = await s.call_tool(tool, args or {})
    text = "\n".join(c.text for c in res.content if hasattr(c, "text"))
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def call_sync(tool: str, args: dict | None = None, timeout: float = 60):
    return asyncio.run(call(tool, args, timeout))
