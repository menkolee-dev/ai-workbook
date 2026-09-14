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
4. 코드 상단의 다음 줄을:
   ```
   const GEMINI_API_KEY = '여기에_발급받은_Gemini_API_키를_붙여넣으세요';
   ```
   1단계에서 복사한 실제 키로 교체합니다 (따옴표는 유지)
5. 프로젝트 이름을 원하는 대로 바꿔도 됩니다 (예: "AX Expert 채점", 선택 사항)
6. `Ctrl+S`로 저장

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
   ```
2. 3단계에서 복사한 실제 웹 앱 URL로 통째로 교체합니다
3. 저장 후 GitHub에 커밋 & push (GitHub Desktop에서 Commit → Push)

## 5단계. 테스트
1. 배포된 사이트에서 아무 미션이나 진행
2. 마지막 "12 Missions · 최종 결과 제출" 화면으로 이동
3. 이름/학번 입력 후 "AI 채점 받기" 클릭
4. 10~20초 후 점수와 피드백이 표시되면 성공

## 나중에 코드를 수정하려면
script.google.com에서 프로젝트를 열어 코드 수정 → 저장 → "배포" → "배포 관리" → 연필 아이콘 → "새 버전"으로 다시 배포하면 **URL이 그대로 유지**됩니다.

## 비용
- Gemini API 무료 등급으로 학급 단위 사용에 충분합니다 (분당/일일 요청 제한 있음)
- Google Apps Script 자체는 무료입니다
