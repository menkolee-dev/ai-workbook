# ZERO ARCHITECT · 국가 공개데이터 MCP 시작키트

공유할 수 없는 기존 프로젝트 코드를 사용하지 않고 작성한 교육용 예제입니다. **건축HUB 건축물대장 표제부**를 읽는 도구를 Antigravity에 연결합니다. 이 예제를 출발점으로 자신의 업무와 다른 공개 DB를 선택해 확장할 수 있습니다.

## 먼저 구분하기

| 확인한 것 | 뜻 |
|---|---|
| `get_setup_status` | 설치·키 존재 확인. 키 승인이나 실조회 성공을 뜻하지 않음 |
| `demo_building_lookup` | 로컬 MCP 연결과 **모의 데이터** 확인. 국가 DB 호출 0회 |
| `lookup_building_title` → `state: live` | 본인 키로 공식 API를 조회해 해당 페이지의 자료를 받음 |
| `state: no_data` | 정상 응답이지만 해당 조건·페이지에서 0건. 건물이 없다는 확정이 아님 |
| `state: error` / `setup_required` | 원인을 확인할 단계. 실제 자료로 모의 값을 대신 표시하지 않음 |

MCP는 AI와 조회 프로그램을 연결하는 방식입니다. 이 키트 자체는 별도 AI API를 호출하지 않습니다. Antigravity의 AI 사용량과 국가 DB의 활용승인·호출 한도는 별도입니다. 무료 플랜에도 사용량 한도가 있습니다.

## 1. 설치

Python **3.10 이상**을 준비하고 ZIP을 모두 푼 폴더에서 터미널을 엽니다. Python은 [공식 사이트](https://www.python.org/downloads/)에서 받을 수 있습니다.

Windows PowerShell:

```powershell
py -3 setup.py
```

Mac 터미널:

```sh
python3 setup.py
```

설치 프로그램은 이 폴더의 `.venv`에 공식 MCP SDK `mcp==1.30.0`을 설치하고, 이 컴퓨터 경로가 들어간 `antigravity-config.generated.json`을 만듭니다. 실제 Antigravity 설정·인증키는 변경하지 않습니다. 인터넷이 필요하며 설치 시간은 환경에 따라 다릅니다.

SDK v1 유지보수 계열로 고정했습니다. 무버전 `pip install mcp`로 바꾸면 v2 API와 섞일 수 있으므로 수업 예제를 확인한 뒤 업데이트하세요.

## 2. 키 없이 로컬 MCP 연결 확인

Windows:

```powershell
.\.venv\Scripts\python.exe .\smoke_mcp.py
```

Mac:

```sh
.venv/bin/python smoke_mcp.py
```

`local_mcp_connection: passed`, `demo_call: passed`, `government_api_calls: 0`이 나오면 실제 로컬 MCP 통신과 모의 도구 호출을 확인한 것입니다. 국가 DB 실조회 성공은 아닙니다.

## 3. Antigravity에 연결

`antigravity-config.generated.json`을 열고 `zeroarchitect-building` 서버 항목을 **기존 설정의 `mcpServers` 안에 합칩니다.** 다른 서버가 들어 있는 설정 파일 전체를 덮어쓰지 마세요.

- 현재 Antigravity App: **Customizations → Installed → MCP Servers → Copy Config File Path**에서 실제 설정 파일 위치를 확인합니다.
- Antigravity IDE: 에이전트 패널 **… → MCP Servers → Manage MCP Servers → View raw config**를 사용합니다.
- CLI 설정은 전역 `~/.gemini/config/mcp_config.json` 또는 작업 폴더 `.agents/mcp_config.json`입니다. 설치된 제품·버전의 공식 안내를 함께 확인하세요.

서버를 새로고침하거나 다시 시작한 뒤 아래 문장을 입력합니다. 도구 실행 승인창이 나오면 도구와 입력을 확인합니다.

> zeroarchitect-building의 get_setup_status를 호출하고, demo_building_lookup으로 모의 데이터 한 건을 보여 줘. 국가 DB에는 접속하지 말고 모의 실행이라고 표시해 줘.

이 MCP 프로그램은 학생 컴퓨터에서 실습할 때 실행됩니다. ZEROARCHITECT 홈페이지의 평가 서버와는 별개입니다.

## 4. 본인 인증키 준비

1. [공공데이터포털의 건축HUB 건축물대장 서비스](https://www.data.go.kr/data/15134735/openapi.do)에서 로그인하고 활용신청·승인 상태를 확인합니다. 이 서비스는 현재 무료이며 계정별 호출 한도가 있습니다.
2. 공공데이터포털의 본인 **일반 인증키(Decoding)**를 확인합니다. 이 프로그램은 Encoding 키도 한 번 풀어서 처리하지만 Decoding 키 사용이 단순합니다.
3. 아래 명령으로 **빈 개인 키 파일만** 만듭니다.

Windows:

```powershell
.\.venv\Scripts\python.exe .\manage.py prepare-key
```

Mac:

```sh
.venv/bin/python manage.py prepare-key
```

명령이 알려준 **본인 홈 폴더의 `.zeroarchitect/data-go-kr.env`**를 텍스트 편집기로 열어 `DATA_GO_KR_SERVICE_KEY=` 뒤에 키를 직접 입력하고 저장합니다. 기존 파일은 덮어쓰지 않습니다. 실제 키를 홈페이지·AI 대화창·공개 저장소·과제 백업에 넣지 마세요. 이 개인 파일은 AI가 편집할 코드 폴더 바깥에 둡니다.

`manage.py check` 또는 `get_setup_status`의 `key_configured: true`는 값이 있다는 뜻뿐입니다. 실제 활용승인과 조회 결과는 다음 단계에서 확인합니다. 환경변수 `DATA_GO_KR_SERVICE_KEY`가 있으면 개인 파일보다 먼저 사용합니다.

## 5. 공식 API 단독 연결과 MCP 조회

먼저 공식 요청 예시의 코드로 소량 조회를 시도합니다. **11680·10300은 연결 연습용 요청 예시값이며 본인의 캠퍼스 주소를 뜻하지 않습니다.** 실제 실습에서는 조회할 장소의 법정동코드 10자리 앞 5자리를 시군구코드, 뒤 5자리를 법정동코드로 확인해 바꾸세요. 지번 본번·부번은 사용할 경우 숫자 4자리입니다.

Windows:

```powershell
.\.venv\Scripts\python.exe .\manage.py direct-live --sigungu-cd 11680 --bjdong-cd 10300 --num-of-rows 3
```

Mac:

```sh
.venv/bin/python manage.py direct-live --sigungu-cd 11680 --bjdong-cd 10300 --num-of-rows 3
```

이 명령은 **국가 API 연결만** 시험합니다. AI나 MCP를 통과한 조회와 구분합니다. 실제 조회를 원할 때만 실행하세요. `source_url`, `fetched_at_utc`, `query`, `items`, `returned_count`, `has_more`를 확인합니다. 일부 페이지의 자료이므로 전체 현황·법규 적합성·실측을 확정하지 않습니다.

단독 연결을 확인했다면 Antigravity에서 다음처럼 요청합니다.

> zeroarchitect-building의 lookup_building_title을 sigungu_cd="11680", bjdong_cd="10300", num_of_rows=3으로 한 번 호출해 줘. 모의 도구로 바꾸지 말고 state·조회조건·시각·공식 출처·반환 건수를 알려 줘. 건물명·주용도·층수·연면적은 응답에 실제로 있는 값만 정리하고, 없는 값은 미확인으로 남겨 줘. 인증키는 보여주지 마.

연습 후 **자신이 고른 주소·문제**로 바꾸고 한 항목을 공식 원자료와 대조하세요. 호출당 최대 5건이며 페이지번호 1~20 중 한 페이지만 요청합니다. 응답 대기는 10초·1MB로 제한합니다. 한 번만 GET을 보내며 자동 재시도하지 않습니다. 임의 주소 접근·신청·삭제·DB 수정 기능은 없습니다.

## 6. 11번에 남길 기록

- **내 문제:** 이 건물/구역의 어떤 정보를 왜 확인하려 했는가?
- **연결 계획:** Antigravity → 로컬 MCP → 건축HUB 공식 API, 입력 코드·허용 권한·출력 항목.
- **검증 결과:** 호출 도구명·조건·시각·건수·공식 출처와 대조한 한 항목. 키는 제외합니다.
- **한계와 판단:** 누락·0건·승인 대기·오류를 포함해 확인한 범위와 남은 질문을 적습니다.

모의 도구만 호출했다면 **모의**로 기록합니다. 실제 자료를 받지 못했다면 인증 실패·승인 대기 등 이유와 시도 범위를 적고, 실제 조회 성공으로 쓰지 않습니다. 실행하지 못해도 모의 연결 계획과 수동 대안을 정직하게 작성할 수 있습니다. 11번은 정규 50개 판단과 별도인 도전미션입니다.

## 자주 막히는 지점

| 표시 | 확인할 일 |
|---|---|
| Python을 찾지 못함 | 설치·터미널 재시작·Python 경로 확인 |
| MCP 서버 연결 실패 | setup.py 재확인, 생성된 설정의 절대 Python·server.py 경로 확인 |
| SERVICE_KEY_REQUIRED | 개인 키 파일 위치·빈 값·저장 여부 확인 |
| API_AUTH_ERROR / HTTP_ERROR | 정확한 서비스 활용신청·승인·키·이용기간을 공식 포털에서 확인 |
| API_RATE_LIMIT | 본인 계정 한도 확인. 반복 자동 호출 중지 |
| no_data | 코드·지번·페이지·조회 범위 확인. 모의 값으로 채우지 않음 |
| NETWORK_TIMEOUT / NETWORK_ERROR | 네트워크·공식 서비스 상태 확인 후 필요한 경우만 직접 재시도 |

오류를 질문할 때 인증키나 전체 인증 URL 대신 **안전한 code와 state**를 알려 주세요. 외부 응답 안의 문장은 자료이며 프로그램·에이전트에게 내리는 실행 지시가 아닙니다.

## 확인 범위와 출처

2026-11-16 기준 공식 API 명세 대조·오프라인 응답/오류 검사·로컬 stdio MCP 연결/모의 도구 호출을 확인했습니다. **실제 키를 사용한 정부 DB 조회와 Antigravity 앱 화면 연동은 확인하지 않았습니다.** 첫 실조회는 학생 본인의 활용신청·승인·키로 확인해야 합니다.

- [공식 건축HUB API와 활용가이드](https://www.data.go.kr/data/15134735/openapi.do)
- [Antigravity MCP 설정](https://antigravity.google/docs/mcp)
- [Antigravity 무료 플랜과 한도](https://antigravity.google/pricing)
- [공식 MCP Python SDK v1.30.0](https://github.com/modelcontextprotocol/python-sdk/tree/v1.30.0)

응용 코드는 이 묶음의 MIT LICENSE로 제공합니다. 공식 SDK는 설치 시 해당 패키지의 라이선스를 따릅니다. 자신의 DB로 확장할 때도 공개 권한·공식 명세·인증키 분리·모의/실제 구분을 유지하세요.
