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

// 4) 응시 기록 시트가 처음 만들어질 때 링크를 한 번 받을 관리자 이메일. 비워두면 이 알림을 보내지 않습니다.
//    (학생이 채점받을 때마다 매번 메일이 오지는 않습니다 — 전체 명단은 아래 응시 기록 시트에서 확인하세요.)
const ADMIN_EMAIL = 'kwlee@kbu.ac.kr';

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
    logToRoster(payload, report);
    return jsonResponse({ ok: true, report: report });
  } catch (err) {
    return jsonResponse({ ok: false, error: String((err && err.message) || err) });
  }
}

// 응시자 명단을 모아 보는 구글 시트를 가져오거나, 없으면 처음 한 번만 새로 만든다.
function getOrCreateRosterSheet() {
  const props = PropertiesService.getScriptProperties();
  let sheetId = props.getProperty('ROSTER_SHEET_ID');
  let ss = null;
  if (sheetId) {
    try { ss = SpreadsheetApp.openById(sheetId); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Architecture AX Expert - 응시 기록');
    props.setProperty('ROSTER_SHEET_ID', ss.getId());
    const sheet = ss.getSheets()[0];
    sheet.setName('응시 기록');
    const headers = ['날짜', '시각', '이름', '학번', '코어 미션 완료', '종합 등급', '총평', '보완 필요 미션'];
    sheet.appendRow(headers);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight('bold').setBackground('#174c43').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, 2, 100);
    sheet.setColumnWidths(3, 4, 110);
    sheet.setColumnWidth(7, 260);
    sheet.setColumnWidth(8, 160);
    if (ADMIN_EMAIL) {
      try {
        MailApp.sendEmail(ADMIN_EMAIL, '[AX Expert] 응시 기록 시트가 생성되었습니다',
          '학생이 셀프평가를 받을 때마다 아래 시트에 날짜·시각·이름·학번·결과가 한 줄씩 자동으로 쌓입니다.\n\n' + ss.getUrl() +
          '\n\n이 메일은 시트가 맨 처음 만들어질 때 한 번만 발송됩니다. 링크를 즐겨찾기 해두세요.');
      } catch (e) { /* 메일 실패는 무시 */ }
    }
  }
  return ss.getSheets()[0];
}

// 채점 결과를 응시 기록 시트에 한 줄 추가한다. 실패해도 학생의 채점 응답에는 영향을 주지 않는다.
function logToRoster(payload, report) {
  try {
    const sheet = getOrCreateRosterSheet();
    const student = payload.student || {};
    const now = new Date();
    const tz = Session.getScriptTimeZone() || 'Asia/Seoul';
    const dateStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    const timeStr = Utilities.formatDate(now, tz, 'HH:mm');
    sheet.appendRow([
      dateStr,
      timeStr,
      student.name || '미기재',
      student.studentId || '미기재',
      report.completedCount || '-',
      report.overallTier || '-',
      report.overallComment || '',
      (report.weakMissions || []).join(', ')
    ]);
  } catch (e) {
    // 시트 기록 실패(권한, 일시적 오류 등)는 조용히 무시한다.
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

// 텍스트 요약에서는 제외하고 별도로 이미지 파트로 첨부할 필드명들
// (imageData=1~9번 메인 이미지, slideImage*=10번 슬라이드, refImage*=11·12번 스크린샷, cmpImage*=05번 비교 이미지)
const IMAGE_FIELD_KEYS = ['imageData', 'slideImage1', 'slideImage2', 'slideImage3', 'refImageStart', 'refImageMiddle', 'refImageFinal', 'refImageMcp', 'cmpImageBefore', 'cmpImageAfter', 'cmpImageFinal'];
// 안전장치: 이미지 1장당 base64 용량 상한(약 1.2MB 원본 기준). 이보다 크면 손상되었거나 비정상 데이터로 보고 건너뛴다.
const MAX_IMAGE_BASE64_CHARS = 1600000;
// 30명 규모 학급에서도 한 요청이 오래 걸리거나 실패하지 않도록, 한 번의 채점 요청에 실제로 첨부하는 이미지 수를 제한한다.
// (학생이 더 많이 올려도, 초과분은 이미지 없이 텍스트 기준으로만 채점되며 감점 사유가 되지 않는다.)
const MAX_IMAGES_PER_REQUEST = 6;

function hasAnyImage(f) {
  return !!(f && IMAGE_FIELD_KEYS.some(function (k) { return f[k]; }));
}

function buildSummary(payload) {
  const student = payload.student || {};
  const missions = payload.missions || [];
  const core = missions.filter(function (m) { return m.id !== '11' && m.id !== '12'; });
  const completedCount = core.filter(function (m) { return m.completed; }).length;
  const imageMissionCount = missions.filter(function (m) { return hasAnyImage(m.fields); }).length;

  const lines = [];
  lines.push('학생 이름: ' + (student.name || '미기재'));
  lines.push('학번: ' + (student.studentId || '미기재'));
  lines.push('코어 미션(01~10) 완료 개수: ' + completedCount + ' / ' + core.length);
  lines.push('이미지가 첨부된 미션 수: ' + imageMissionCount + ' (실제로 이 요청에 첨부되는 이미지는 최대 ' + MAX_IMAGES_PER_REQUEST + '장이며, [미션 NN 첨부 이미지] 라벨과 함께 순서대로 첨부됨. 초과분은 텍스트 기록만으로 판단할 것)');
  lines.push('');
  missions.forEach(function (m) {
    lines.push('[미션 ' + m.id + '] ' + m.title + ' - ' + (m.completed ? '완료' : '미완료'));
    const f = m.fields || {};
    let hasField = false;
    Object.keys(f).forEach(function (k) {
      if (k === 'completed' || k === 'compareHistory' || IMAGE_FIELD_KEYS.indexOf(k) !== -1) return;
      const v = f[k];
      if (v === undefined || v === null || v === '') return;
      if (k === 'compare' && typeof v === 'object') {
        lines.push('  - 비교 판단(확인 항목): ' + (v.checked || ''));
        lines.push('  - 비교 판단(문제 유무): ' + (v.verdict || ''));
        lines.push('  - 비교 판단(근거): ' + (v.reason || ''));
        lines.push('  - 비교 판단(조치): ' + (v.action || ''));
        hasField = true;
        return;
      }
      if (typeof v === 'object') return; // 예상치 못한 객체 필드는 건너뛴다
      lines.push('  - ' + k + ': ' + v);
      hasField = true;
    });
    if (hasAnyImage(f)) lines.push('  - (첨부 이미지 있음, 아래 참고)');
    if (!hasField && !hasAnyImage(f)) lines.push('  (기록 없음)');
    lines.push('');
  });
  return lines.join('\n');
}

// 미션별 첨부 이미지를 Gemini 멀티모달 파트(라벨 텍스트 + inlineData)로 변환한다.
// 코어 미션(01~10)을 보너스(11~12)보다 우선 포함하고, 전체 개수는 MAX_IMAGES_PER_REQUEST로 제한한다.
function buildImageParts(payload) {
  const missions = payload.missions || [];
  const parts = [];
  let count = 0;
  const ordered = missions.slice().sort(function (a, b) {
    const aBonus = (a.id === '11' || a.id === '12') ? 1 : 0;
    const bBonus = (b.id === '11' || b.id === '12') ? 1 : 0;
    return aBonus - bBonus;
  });
  ordered.forEach(function (m) {
    const f = m.fields || {};
    IMAGE_FIELD_KEYS.forEach(function (key) {
      if (count >= MAX_IMAGES_PER_REQUEST) return;
      const dataUrl = f[key];
      if (!dataUrl || typeof dataUrl !== 'string') return;
      const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!match) return;
      const mimeType = match[1];
      const base64 = match[2];
      if (base64.length > MAX_IMAGE_BASE64_CHARS) return; // 비정상적으로 큰 데이터는 건너뛴다
      parts.push({ text: '[미션 ' + m.id + ' 첨부 이미지]' });
      parts.push({ inlineData: { mimeType: mimeType, data: base64 } });
      count++;
    });
  });
  return parts;
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
    '4) 전체적으로 학생을 격려하는 따뜻한 톤으로 코멘트를 작성하고, "노력 필요"인 경우에도 다음에 시도할 수 있는 구체적인 방향을 제시해라.\n' +
    '5) 각 등급은 반드시 아래 기준으로 판단해라 (제출 여부가 아니라 내용의 질로 판단):\n' +
    '   - 노력 필요: 답변이 비어있거나, 한두 단어 수준으로 매우 짧거나, 미션과 무관하거나 형식적인 내용(예: "짧게", "완료", "네")뿐인 경우\n' +
    '   - 보통: 답변은 있으나 구체적인 근거나 예시 없이 일반적인 수준에 그치는 경우\n' +
    '   - 잘함: 무엇을 관찰했고 어떤 근거로 판단했는지가 구체적으로 드러나는 경우\n' +
    '   - 매우 잘함: 매우 구체적인 관찰/근거에 더해 실제 기준(시공·전공·현장 조건 등)과의 비교, 명확한 판단 이유까지 모두 드러나는 경우\n' +
    '   글자 수가 많다고 무조건 높은 등급을 주지 말고, 내용이 비어 있거나 성의 없이 짧으면 반드시 "노력 필요"로 평가해라.\n' +
    '6) 완성도(개수)를 종합 등급(overallTier)의 상한선으로 반드시 적용해라 — 아무리 내용이 훌륭해도 완료한 미션 수가 적으면 종합 등급을 그 이상 줄 수 없다:\n' +
    '   - 코어 미션 10개 중 3개 이하 완료: overallTier는 "노력 필요"를 넘을 수 없다\n' +
    '   - 4~6개 완료: "보통"을 넘을 수 없다\n' +
    '   - 7~8개 완료: "잘함"을 넘을 수 없다\n' +
    '   - 9~10개 완료해야만 "매우 잘함"이 가능하다\n' +
    '   (개별 criteria 항목 등급은 실제로 기록이 있는 미션들의 내용만 보고 판단하되, overallTier는 위 상한선 규칙을 반드시 지켜라.)\n' +
    '7) "(기록 없음)"으로 표시된 미완료 미션은 해당 내용이 전혀 없는 것이므로 관련 criteria 판단 시 낮은 근거로 반영해라.\n' +
    '8) 여러 미션의 답변 문장이 서로 거의 동일하거나 복사해서 붙여넣은 것처럼 보이면(미션 내용이 다른데 문장이 같은 경우), 이는 실제 관찰·실험이 이루어지지 않았다는 신호이므로 해당 부분을 "보통" 이하로 평가하고 overallComment에 이 점을 짧게 언급해라.\n' +
    '9) 학생이 고른 최종 결정(decisionType: 채택/수정/거부)과 실제로 적은 근거(decision) 내용이 서로 모순되면(예: 채택을 선택했는데 근거는 문제점만 나열) "오류 대응" 기준 평가에 반영해라.\n' +
    '10) [중요] 프롬프트 뒤에 [미션 NN 첨부 이미지] 라벨과 함께 이미지가 첨부된 경우, 그 이미지의 주된 용도는 "이 미션을 실제로 수행했는지 확인하는 필터"다. ' +
    '건축·공간·인테리어·도면·모델링·건물 관련 이미지가 아니라 명백히 무관한 이미지(예: 사람 얼굴 셀카, 음식, 동물, 밈, 스크린샷이 아닌 채팅 화면, 완전한 단색/빈 이미지, 미션 주제와 전혀 상관없는 사진)라면, ' +
    '텍스트 답변이 아무리 그럴듯해도 해당 미션 관련 criteria(특히 "사전 관찰", "기록의 구체성")를 반드시 "노력 필요"로 낮추고, overallComment에 "이미지가 미션 주제와 맞지 않습니다" 라고 짧게 언급해라. ' +
    '반대로 이미지가 건축/공간 관련 내용이 맞고 텍스트 설명과 대체로 일치하면 이미지 자체의 미적 완성도는 채점하지 말고(완성 이미지가 아니라 판단 과정이 핵심이므로) 정상적으로 텍스트 기준을 그대로 적용해라.\n\n' +
    '채점 기준 (미션 01~10 전용):\n' + criteriaList + '\n\n' +
    '반드시 아래 JSON 형식으로만 응답하고 다른 텍스트는 절대 포함하지 마라 (숫자 점수 필드를 절대 추가하지 마라):\n' +
    '{"completedCount":"N/10 형식의 문자열","overallTier":' + tierOptions + ',"overallComment":"총평 2문장 이내","criteria":[{"name":"기준명","tier":' + tierOptions + ',"comment":"코멘트 1문장"}],' +
    '"weakMissions":["보완이 필요한 미션 번호(01~10)만 배열로, 없으면 빈 배열"],' +
    '"bonusMissions":[{"id":"11","label":"11번 · 공공건축 MCP 분석","completed":true 또는 false,"comment":"코멘트 1문장"},{"id":"12","label":"12번 · AI 건축 모델링 검증","completed":true 또는 false,"comment":"코멘트 1문장"}]}\n' +
    '(criteria 배열은 반드시 위 5개 기준 각각에 대해 하나씩, 총 5개 항목. bonusMissions는 반드시 11번, 12번 각각 하나씩 총 2개 항목)\n\n' +
    '학생 기록:\n' + summary;

  const imageParts = buildImageParts(payload);
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_API_KEY;
  const body = {
    contents: [{ parts: [{ text: prompt }].concat(imageParts) }],
    generationConfig: { temperature: 0.3, responseMimeType: 'application/json' }
  };

  // Gemini가 일시적으로 혼잡(503)하거나 요청이 몰릴 때(429)는 점점 더 길게 쉬었다가 자동으로 재시도한다.
  const RETRY_STATUSES = [503, 429, 500];
  const MAX_ATTEMPTS = 4;
  let status, text;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    status = res.getResponseCode();
    text = res.getContentText();
    if (status === 200) break;
    if (RETRY_STATUSES.indexOf(status) === -1 || attempt === MAX_ATTEMPTS) break;
    Utilities.sleep(1500 * Math.pow(2, attempt - 1)); // 1.5초, 3초, 6초 간격으로 재시도
  }

  if (status !== 200) {
    if (RETRY_STATUSES.indexOf(status) !== -1) {
      throw new Error('AI 서버가 지금 일시적으로 혼잡합니다 (' + MAX_ATTEMPTS + '번 재시도 후에도 응답 없음). 30초~1분 후 "셀프평가하기"를 다시 눌러주세요.');
    }
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
