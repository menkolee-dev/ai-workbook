# AI 채점 기능 배포 방법 (Google Apps Script)

`index.html`의 "AI 채점 받기" 버튼이 실제로 작동하려면, 무료 백엔드(Google Apps Script + Gemini API)를 배포해야 합니다.
**Google 계정 로그인이 필요한 단계**라서 직접 진행해 주셔야 합니다. 전체 10분 이내로 끝납니다.

## 1단계. Gemini API 키 발급 (무료)
1. https://aistudio.google.com/apikey 접속 (Google 계정 로그인)
2. "Create API key" 클릭
3. 생성된 키를 복사해 둡니다 (예: `AIzaSy...`로 시작)

## 2단계. Google Apps Script 프로젝트 만들기
1. https://script.google.com 접속
2. "새 프로젝트" 클릭
3. 기본으로 열려 있는 `Code.gs`의 내용을 전부 지우고, 이 저장소의 [`backend/Code.gs`](backend/Code.gs) 파일 내용을 전체 복사해서 붙여넣습니다
4. **API 키는 코드에 직접 쓰지 않고 "스크립트 속성"에 등록합니다** (이 저장소는 공개 GitHub 저장소라서, 코드에 실제 키를 적으면 인터넷에 그대로 노출됩니다):
   - 왼쪽 메뉴에서 톱니바퀴 아이콘("프로젝트 설정") 클릭
   - 맨 아래 "스크립트 속성" 섹션에서 "스크립트 속성 추가" 클릭
   - 속성 이름 `GEMINI_API_KEY`, 값에 1단계에서 복사한 실제 키를 입력 후 저장
   - GPT-5.6 Terra(대회 심사 전용)를 쓰려면 같은 방법으로 속성 이름 `OPENAI_API_KEY`도 추가합니다 (platform.openai.com에서 발급, 결제수단 등록 필요)
5. 다시 코드 편집기로 돌아와 `CLASS_SECRET` 값을 원하는 비밀번호로 바꿉니다:
   ```
   const CLASS_SECRET = '원하는-비밀번호로-변경';
   ```
   무작위 봇이 채점 서버를 무단으로 호출하는 것을 막는 간단한 장치입니다. **이 값은 잠시 후 index.html의 `GAS_SECRET` 값과 반드시 똑같이 맞춰야 합니다.**
6. 프로젝트 이름을 원하는 대로 바꿔도 됩니다 (예: "AX Expert 채점", 선택 사항)
7. `Ctrl+S`로 저장

### 참고: Gemini ↔ GPT-5.6 Terra 전환
`Code.gs` 상단의 `ACTIVE_PROVIDER` 값을 `'gemini'`(학생 공개 기본값, 무료·빠름) 또는 `'openai'`(대회 심사 전용, 유료·더 깊은 판단)로 바꾸고 재배포하면 채점 모델이 바뀝니다. `OPENAI_API_KEY` 스크립트 속성이 없으면 `'openai'` 모드는 오류를 반환합니다.

## 3단계. 웹 앱으로 배포
1. 오른쪽 위 "배포" → "새 배포" 클릭
2. 톱니바퀴(유형 선택) → "웹 앱" 선택
3. 다음과 같이 설정:
   - 설명: 아무거나 (예: v1)
   - 다음 사용자 인증 정보로 실행: **나**
   - 액세스 권한이 있는 사용자: **모든 사용자**
4. "배포" 클릭
5. Google 권한 승인 화면이 뜨면 "고급" → "(프로젝트명)(안전하지 않음)으로 이동" → 허용
   (본인이 직접 만든 스크립트이므로 안전합니다. Google이 아직 검토하지 않은 개인 프로젝트라서 뜨는 표준 경고입니다.)
6. 배포 완료 후 나오는 **웹 앱 URL**을 복사합니다
   (`https://script.google.com/macros/s/AKfycb.../exec` 형식)

## 4단계. index.html에 연결
1. `index.html`에서 다음 줄을 찾습니다:
   ```
   const GAS_ENDPOINT='https://script.google.com/macros/s/여기에_배포된_스크립트_ID를_붙여넣으세요/exec';
   const GAS_SECRET='원하는-비밀번호로-변경';
   ```
2. `GAS_ENDPOINT`는 3단계에서 복사한 실제 웹 앱 URL로 교체합니다
3. `GAS_SECRET`은 2단계 5번에서 `Code.gs`에 설정한 `CLASS_SECRET`과 **정확히 동일한 값**으로 교체합니다
4. 저장 후 GitHub에 커밋 & push (GitHub Desktop에서 Commit → Push)

## 5단계. 테스트
1. 배포된 사이트에서 아무 미션이나 진행
2. 마지막 "12 Missions · 최종 결과 제출" 화면으로 이동
3. 이름/학번 입력 후 "AI 채점 받기" 클릭
4. 10~20초 후 점수와 피드백이 표시되면 성공

## 나중에 코드를 수정하려면
script.google.com에서 프로젝트를 열어 코드 수정 → 저장 → "배포" → "배포 관리" → 연필 아이콘 → "새 버전"으로 다시 배포하면 **URL이 그대로 유지**됩니다.

## 비용 및 사용량 안전장치
- Gemini API 무료 등급으로 학급 단위 사용(하루 100명 미만)에 충분합니다.
- `Code.gs`의 `MAX_DAILY_REQUESTS`(기본값 300)는 무단 대량 호출로 무료 할당량이 소진되는 것을 막는 안전장치입니다. 실제 학생 수보다 넉넉하게 잡혀 있으니 수업 운영에는 영향이 없습니다. 필요하면 숫자를 조정할 수 있습니다.
- `CLASS_SECRET`은 무작위 봇의 스캔을 막는 1차 방어선입니다. 완벽한 보안은 아니지만(공개 소스코드에 값이 있음), 대부분의 자동화된 악용 시도를 걸러냅니다.
