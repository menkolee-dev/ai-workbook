"""Local setup and clearly synthetic data; no network requests in this module."""
from __future__ import annotations

import importlib.metadata
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

KEY_VARIABLE = "DATA_GO_KR_SERVICE_KEY"


def configure_utf8_cli() -> None:
    """Only human CLI entry points call this; MCP protocol streams use the SDK."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def key_file() -> Path:
    override = os.environ.get("ZEROARCHITECT_KEY_FILE", "").strip()
    return Path(override).expanduser() if override else Path.home() / ".zeroarchitect" / "data-go-kr.env"


def _usable(value: str) -> bool:
    return bool(value and value.isascii() and not any(token in value.upper() for token in ("YOUR_KEY", "YOUR_SERVICE_KEY", "REPLACE_ME", "<", ">")))


def read_service_key() -> tuple[str | None, str]:
    """The value is internal only: never return it from an MCP tool or print it."""
    value = os.environ.get(KEY_VARIABLE, "").strip()
    if _usable(value):
        return value, "environment"
    try:
        path = key_file()
        if path.stat().st_size > 4096:
            return None, "private_file_invalid"
        text = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return None, "missing"
    except (OSError, UnicodeError):
        return None, "private_file_unreadable"
    for line in text.splitlines():
        name, separator, raw = line.partition("=")
        if separator and name.strip() == KEY_VARIABLE:
            value = raw.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1].strip()
            return (value, "private_file") if _usable(value) else (None, "private_file_empty")
    return None, "private_file_empty"


def setup_status() -> dict:
    value, source = read_service_key()
    try:
        sdk = importlib.metadata.version("mcp")
    except importlib.metadata.PackageNotFoundError:
        sdk = "not_installed"
    return {"state": "setup_check", "key_configured": value is not None, "key_source": source,
            "mcp_sdk": sdk, "network_calls": 0,
            "note": "키의 존재만 확인했습니다. 키 유효성·활용 승인·국가 DB 조회 성공을 확인한 결과가 아닙니다."}


def demo_lookup() -> dict:
    return {"state": "demo", "is_demo": True, "data_origin": "synthetic", "network_calls": 0,
            "checked_at_utc": datetime.now(timezone.utc).isoformat(),
            "note": "모의 데이터입니다. 실제 국가 DB를 조회하지 않았습니다.",
            "items": [{"bldNm": "가상 학습동 A (모의)", "platPlc": "가상 학습구역 — 실제 주소 아님",
                       "mainPurpsCdNm": "교육연구시설 (가상)", "totArea": "1234.5", "grndFlrCnt": "3"}],
            "record_hint": "실행 방식은 모의로 기록하고, 연결한 도구·입력·가상 결과·실제 조회가 남아 있는 이유를 적으세요."}


def prepare_key_file() -> dict:
    path = key_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8") as handle:
            handle.write("# 본인이 공공데이터포털에서 발급받은 인증키를 아래 = 뒤에 직접 입력합니다.\n")
            handle.write("# 홈페이지, AI 대화창, 과제 백업, GitHub에 키를 넣지 마세요.\n")
            handle.write(KEY_VARIABLE + "=\n")
        if os.name != "nt":
            path.chmod(0o600)
        created = True
    except FileExistsError:
        created = False
    return {"created": created, "key_file": str(path), "existing_file_overwritten": False,
            "next": "이 파일을 본인의 텍스트 편집기로 열어 인증키를 직접 입력한 뒤 저장하세요."}
