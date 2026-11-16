"""Real local MCP handshake/list/call test; only setup/demo tools, no government API."""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from starter_support import configure_utf8_cli


async def main() -> None:
    print("로컬 MCP 연결을 확인합니다. 국가 DB는 호출하지 않습니다.", file=sys.stderr, flush=True)
    environment = {}
    if os.environ.get("ZEROARCHITECT_KEY_FILE"):
        environment["ZEROARCHITECT_KEY_FILE"] = os.environ["ZEROARCHITECT_KEY_FILE"]
    parameters = StdioServerParameters(command=sys.executable, args=[str(Path(__file__).resolve().parent / "server.py")], env=environment)
    async with stdio_client(parameters) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            listing = await session.list_tools()
            names = {tool.name for tool in listing.tools}
            assert {"get_setup_status", "demo_building_lookup", "lookup_building_title"} <= names
            setup = await session.call_tool("get_setup_status", {})
            demo = await session.call_tool("demo_building_lookup", {})
            assert not setup.isError and not demo.isError
            data = demo.structuredContent
            if data is None:
                data = json.loads(next(block.text for block in demo.content if block.type == "text"))
            assert data["is_demo"] is True and data["network_calls"] == 0
            print(json.dumps({"local_mcp_connection": "passed", "tools_found": sorted(names),
                              "demo_call": "passed", "government_api_calls": 0,
                              "note": "로컬 MCP 연결과 모의 조회만 확인했습니다. 국가 DB 실조회 성공이 아닙니다."}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    configure_utf8_cli()
    try:
        asyncio.run(asyncio.wait_for(main(), timeout=45))
    except (TimeoutError, asyncio.TimeoutError):
        print("45초 안에 로컬 MCP 연결을 확인하지 못했습니다. 설치된 SDK·Python 경로를 확인하세요.", file=sys.stderr)
        raise SystemExit(2)
