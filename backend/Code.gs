/**
 * Architecture AX Expert - AI 채점 백엔드 (Google Apps Script)
 * 배포 방법: 저장소 루트의 DEPLOY.md 참고
 */

// 1) https://aistudio.google.com/apikey 에서 무료로 발급받은 Gemini API 키를 아래에 붙여넣으세요.
const GEMINI_API_KEY = '여기에_발급받은_Gemini_API_키를_붙여넣으세요';
const GEMINI_MODEL = 'gemini-3.6-flash';

// 2) 무작위 봇의 무단 호출을 막기 위한 간단한 공유 비밀번호. 원하는 문자열로 바꾸세요.
//    (index.html의 GAS_SECRET 값도 반드시 이 값과 동일하게 맞춰야 합니다.)
const CLASS_SECRET = '원하는-비밀번호로-변경';

// 3) 하루 최대 채점 횟수. 무단 대량 호출로 무료 할당량이 소진되는 것을 막는 안전장치입니다.
const MAX_DAILY_REQUESTS = 300;

const CRITERIA = [
  { key: 'observation', name: '사전 관찰' },
  { key: 'experiment', name: 'AI 실험 체계성' },
  { key: 'evidence', name: '근거 대조' },
  { key: 'errorHandling', name: '오류 대응' },
  { key: 'documentation', name: '기록의 구체성' }
];

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    if (CLASS_SECRET && payload.secret !== CLASS_SECRET) {
      return jsonResponse({ ok: false, error: '인증 실패: secret 값이 올바르지 않습니다.' });
    }
    checkAndIncrementDailyQuota();

    const report = gradeWithAI(payload);
    return jsonResponse({ ok: true, report: report });
  } catch (err) {
    return jsonResponse({ ok: false, error: String((err && err.message) || err) });
  }
}

// 하루 호출 횟수를 세어 MAX_DAILY_REQUESTS를 넘으면 예외를 던진다.
function checkAndIncrementDailyQuota() {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Seoul', 'yyyy-MM-dd');
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const key = 'reqCount_' + today;
    const count = Number(props.getProperty(key) || '0');
    if (count >= MAX_DAILY_REQUESTS) {
      throw new Error('오늘의 채점 요청 한도(' + MAX_DAILY_REQUESTS + '회)를 초과했습니다. 내일 다시 시도하거나 관리자에게 문의하세요.');
    }
    props.setProperty(key, String(count + 1));
  } finally {
    lock.releaseLock();
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function buildSummary(payload) {
  const student = payload.student || {};
  const missions = payload.missions || [];
  const lines = [];
  lines.push('학생 이름: ' + (student.name || '미기재'));
  lines.push('학번: ' + (student.studentId || '미기재'));
  lines.push('');
  missions.forEach(function (m) {
    lines.push('[미션 ' + m.id + '] ' + m.title + ' - ' + (m.completed ? '완료' : '미완료'));
    const f = m.fields || {};
    Object.keys(f).forEach(function (k) {
      if (k === 'completed') return;
      const v = f[k];
      if (v === undefined || v === null || v === '') return;
      lines.push('  - ' + k + ': ' + v);
    });
    lines.push('');
  });
  return lines.join('\n');
}

function gradeWithAI(payload) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY.indexOf('여기에_발급받은') !== -1) {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다. DEPLOY.md를 참고해 먼저 API 키를 설정하세요.');
  }

  const summary = buildSummary(payload);
  const criteriaList = CRITERIA.map(function (c) { return '- ' + c.name; }).join('\n');

  const tierOptions = '"매우 잘함" | "잘함" | "보통" | "노력 필요"';
  const prompt =
    '너는 건축·공간디자인 AI 활용 수업의 채점 조교다. 아래 학생의 미션 실습 기록을 읽고 참고용 피드백 카드를 작성해라.\n\n' +
    '중요한 규칙:\n' +
    '1) 반드시 세부 점수나 숫자 점수를 매기지 말고, 아래 4단계 등급 중 하나로만 평가해라: ' + tierOptions + '\n' +
    '2) 미션 01~10(코어 스튜디오)만 아래 5개 기준으로 등급을 매기고, 그것을 종합해 전체 등급(overallTier)도 하나 정해라.\n' +
    '3) 미션 11(공공건축 MCP 분석)과 미션 12(AI 건축 모델링 검증)는 보너스 과제이며 정규 등급 평가에는 절대 포함하지 않는다. ' +
    '두 미션은 완성된 결과물(실제 MCP 실행이나 완성된 영상) 유무로 판단하지 말고, 학생이 기록한 판단 과정(스크린샷 첨부, 검색 질문, 발견한 오류, 최종 결정 등)이 조금이라도 있으면 completed:true, 전혀 없으면 completed:false로만 표시해라.\n' +
    '4) 전체적으로 학생을 격려하는 따뜻한 톤으로 코멘트를 작성하고, "노력 필요"인 경우에도 다음에 시도할 수 있는 구체적인 방향을 제시해라.\n\n' +
    '채점 기준 (미션 01~10 전용):\n' + criteriaList + '\n\n' +
    '반드시 아래 JSON 형식으로만 응답하고 다른 텍스트는 절대 포함하지 마라 (숫자 점수 필드를 절대 추가하지 마라):\n' +
    '{"overallTier":' + tierOptions + ',"overallComment":"총평 2문장 이내","criteria":[{"name":"기준명","tier":' + tierOptions + ',"comment":"코멘트 1문장"}],' +
    '"bonusMissions":[{"id":"11","label":"11번 · 공공건축 MCP 분석","completed":true 또는 false,"comment":"코멘트 1문장"},{"id":"12","label":"12번 · AI 건축 모델링 검증","completed":true 또는 false,"comment":"코멘트 1문장"}]}\n' +
    '(criteria 배열은 반드시 위 5개 기준 각각에 대해 하나씩, 총 5개 항목. bonusMissions는 반드시 11번, 12번 각각 하나씩 총 2개 항목)\n\n' +
    '학생 기록:\n' + summary;

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_API_KEY;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, responseMimeType: 'application/json' }
  };

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  const status = res.getResponseCode();
  const text = res.getContentText();
  if (status !== 200) {
    throw new Error('Gemini API 오류 (' + status + '): ' + text.substring(0, 300));
  }

  const data = JSON.parse(text);
  const raw = data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;
  if (!raw) throw new Error('AI 응답을 읽을 수 없습니다.');

  const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned);
}
