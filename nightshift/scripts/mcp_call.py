"""Call any NightShift MCP tool from the terminal: python scripts/mcp_call.py <tool> '{"arg": 1}'"""
import asyncio
import json
import os
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


def load_env(path=".env"):
    if os.path.exists(path):
        for line in open(path):
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.strip().split("=", 1)
                os.environ.setdefault(k, v.split("#")[0].strip())


async def main():
    load_env()
    url = os.environ.get("MCP_URL", "http://localhost:8000/mcp")
    token = os.environ.get("MCP_TOKEN") or os.environ["OPS_MCP_TOKEN"]
    tool = sys.argv[1] if len(sys.argv) > 1 else ""
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    async with streamablehttp_client(url, headers={"Authorization": f"Bearer {token}"}) as (r, w, _):
        async with ClientSession(r, w) as s:
            await s.initialize()
            if not tool:
                for t in (await s.list_tools()).tools:
                    a = t.annotations
                    kind = "DESTRUCTIVE" if a and a.destructiveHint else ("read" if a and a.readOnlyHint else "write")
                    print(f"{t.name:18} {kind:11} {t.description.splitlines()[0][:90]}")
                return
            res = await s.call_tool(tool, args)
            print("\n".join(c.text for c in res.content if hasattr(c, "text")))


asyncio.run(main())
