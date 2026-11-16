"""Human-operated local setup commands. Contains no AI provider integration."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from starter_support import configure_utf8_cli, demo_lookup, prepare_key_file, read_service_key, setup_status


def mcp_config(python: Path | None = None) -> dict:
    root = Path(__file__).resolve().parent
    return {"mcpServers": {"zeroarchitect-building": {
        "command": str((python or Path(sys.executable)).absolute()), "args": [str(root / "server.py")]}}}


def main() -> int:
    parser = argparse.ArgumentParser(description="ZERO ARCHITECT 국가 DB MCP 실습 보조")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check", help="키 존재만 확인; 국가 DB 호출 없음")
    commands.add_parser("demo", help="명백한 모의 데이터; 국가 DB 호출 없음")
    commands.add_parser("prepare-key", help="개인 키 파일의 빈 양식만 생성; 기존 파일 유지")
    config = commands.add_parser("config", help="현재 Python의 MCP 설정 조각 출력; 실제 앱 설정 변경 없음")
    config.add_argument("--save", action="store_true")
    live = commands.add_parser("direct-live", help="본인 키로 공식 국가 API 연결만 시험; AI/MCP 호출과 구분")
    live.add_argument("--sigungu-cd", required=True)
    live.add_argument("--bjdong-cd", required=True)
    live.add_argument("--plat-gb-cd", default="0")
    live.add_argument("--bun", default="")
    live.add_argument("--ji", default="")
    live.add_argument("--page-no", type=int, default=1)
    live.add_argument("--num-of-rows", type=int, default=3)
    args = parser.parse_args()
    if args.command == "check":
        result = setup_status()
    elif args.command == "demo":
        result = demo_lookup()
    elif args.command == "prepare-key":
        result = prepare_key_file()
    elif args.command == "config":
        result = mcp_config()
        if args.save:
            (Path(__file__).resolve().parent / "antigravity-config.generated.json").write_text(
                json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        from gov_data import lookup_building_title
        key, _ = read_service_key()
        result = lookup_building_title(args.sigungu_cd, args.bjdong_cd, args.plat_gb_cd, args.bun, args.ji,
                                       args.page_no, args.num_of_rows, service_key=key)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 2 if args.command == "direct-live" and result.get("state") in ("setup_required", "error") else 0


if __name__ == "__main__":
    configure_utf8_cli()
    raise SystemExit(main())
