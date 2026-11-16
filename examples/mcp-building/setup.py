"""Prepare a local venv and a config fragment; never edits the IDE's settings."""
from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import venv
from pathlib import Path

from manage import mcp_config
from starter_support import configure_utf8_cli


def main() -> int:
    if sys.version_info < (3, 10):
        print("Python 3.10 이상이 필요합니다.", file=sys.stderr)
        return 2
    root = Path(__file__).resolve().parent
    environment = root / ".venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    try:
        if not python.is_file():
            venv.EnvBuilder(with_pip=True).create(environment)
        subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check",
                        "--index-url", "https://pypi.org/simple", "-r", str(root / "requirements.txt")], check=True,
                       env={**os.environ, "PYTHONUTF8": "1"})
        config_path = root / "antigravity-config.generated.json"
        config_path.write_text(json.dumps(mcp_config(python), ensure_ascii=False, indent=2), encoding="utf-8")
    except (OSError, subprocess.CalledProcessError):
        print("설치를 완료하지 못했습니다. Python·인터넷 연결과 위 pip 오류를 확인하세요. 인증키는 필요하지 않습니다.", file=sys.stderr)
        return 2
    print("\n준비 완료. 국가 DB·AI는 호출하지 않았습니다.")
    print("설정 조각: " + str(config_path))
    print("이 파일의 서버 항목을 Antigravity의 기존 mcpServers에 합치세요. 기존 설정 전체를 덮어쓰지 마세요.")
    smoke_path = str(root / "smoke_mcp.py")
    if os.name == "nt":
        literal = lambda value: "'" + value.replace("'", "''") + "'"
        smoke_command = "& " + literal(str(python)) + " " + literal(smoke_path)
    else:
        smoke_command = shlex.join([str(python), smoke_path])
    print("키 없이 연결 시험: " + smoke_command)
    return 0


if __name__ == "__main__":
    configure_utf8_cli()
    raise SystemExit(main())
