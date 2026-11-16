"""ZERO ARCHITECT learning MCP: local stdio, explicit demo, one read-only API."""
from __future__ import annotations

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from gov_data import lookup_building_title as _lookup
from starter_support import demo_lookup, read_service_key, setup_status

mcp = FastMCP("ZERO ARCHITECT 공공건축 데이터 실습", instructions=(
    "설정 확인·모의 조회·실제 국가 DB 조회를 구분합니다. 인증키를 도구 인수나 대화에 입력하지 마세요. "
    "실제 조회는 신청·승인된 본인 키로 공식 API를 한 번 읽습니다. 모의/오류/0건을 실제 건물 정보 확인으로 과장하지 마세요."
))
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=True)


@mcp.tool(annotations=READ_ONLY)
def get_setup_status() -> dict:
    """로컬 설치와 키 존재만 확인합니다. 네트워크와 국가 DB를 호출하지 않습니다."""
    return setup_status()


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
def demo_building_lookup() -> dict:
    """키 없이 MCP 연결을 연습하는 명백한 모의 데이터 조회. 실제 국가 DB 요청은 0회입니다."""
    return demo_lookup()


@mcp.tool(annotations=READ_ONLY)
def lookup_building_title(sigungu_cd: str, bjdong_cd: str, plat_gb_cd: str = "0", bun: str = "", ji: str = "",
                          page_no: int = 1, num_of_rows: int = 3) -> dict:
    """건축HUB 건축물대장 표제부를 본인 승인 키로 읽습니다. 시군구/법정동 각 5자리, 지번은 입력 시 4자리입니다.

    키는 도구 인수가 아닙니다. 로컬 개인 키 파일 또는 환경변수를 사용합니다. 자동 재시도/모의 대체는 하지 않습니다.
    """
    key, _ = read_service_key()
    return _lookup(sigungu_cd, bjdong_cd, plat_gb_cd=plat_gb_cd, bun=bun, ji=ji,
                   page_no=page_no, num_of_rows=num_of_rows, service_key=key)


if __name__ == "__main__":
    mcp.run(transport="stdio")
