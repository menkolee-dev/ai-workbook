/**
 * Architecture AX Expert - AI 채점 백엔드 (Google Apps Script)
 * 배포 방법: 저장소 루트의 DEPLOY.md 참고
 */

// 1) API 키는 이 파일에 직접 적지 않고 "스크립트 속성"에 저장합니다 — 이 저장소는 공개(public) GitHub
//    저장소라서, 코드에 실제 키를 적으면 그대로 인터넷에 노출됩니다.
//    설정 방법: script.google.com에서 이 프로젝트 열기 → 왼쪽 톱니바퀴(프로젝트 설정) → 맨 아래
//    "스크립트 속성" → "스크립트 속성 추가"에서 아래 두 속성을 각각 등록하세요.
//      속성 이름: GEMINI_API_KEY   값: https://aistudio.google.com/apikey 에서 발급받은 키
//      속성 이름: OPENAI_API_KEY   값: https://platform.openai.com/api-keys 에서 발급받은 키
function getApiKey(propName) {
  return PropertiesService.getScriptProperties().getProperty(propName) || '';
}
const GEMINI_MODEL = 'gemini-3.6-flash';

// === 채점 제공자 전환 스위치 ===
// 'gemini' = 평소 학생 셀프평가 기본값(무료, 빠름). 'openai' = 대회 심사 전용(유료, GPT-5.6 Terra, 느리지만 더 깊게 판단).
// [중요] 대회 심사 기간(약 30일)이 끝나면 반드시 'gemini'로 되돌려서 학생 공개용 기본값으로 복귀할 것.
const ACTIVE_PROVIDER = 'openai'; // 'gemini' | 'openai'

// --- OpenAI(GPT-5.6 Terra) 설정: 대회 심사 전용 ---
// 결제수단이 등록된 OpenAI 계정의 키가 필요합니다(위 스크립트 속성 안내 참고).
const OPENAI_MODEL = 'gpt-5.6-terra';
// 정확도보다 응답 속도를 우선하기로 하여 'low'로 낮췄습니다. 이미지를 실제로 보고 판단하는 품질은
// reasoning_effort가 아니라 아래 IMAGE_RULES_DEEP 프롬프트가 담당하므로, 추론 강도를 낮춰도
// 이미지 분석 자체(무엇을 보는지)는 그대로 유지되고 "얼마나 깊이 따져보는지"만 줄어듭니다.
// 그래도 느리면 'minimal'이나 'none'까지 낮출 수 있고(단, 이 모델이 해당 값을 지원하는지는
// 실제로 한 번 호출해봐야 확인됩니다), 반대로 정확도를 다시 올리고 싶으면 'medium'/'high'로.
const OPENAI_REASONING_EFFORT = 'low';
// [예산 안전장치] 심사 기간(30일) 전체 누적 요청 수 상한. 요청 1건당 비용을 넉넉히 잡아(약 $0.06~$0.08)
// 예산 $10 안에서 역산한 값이라 여유를 둔 추정치입니다 — 진짜 상한은 반드시 platform.openai.com
// 계정 설정(Settings → Limits)에서 $10 하드 리밋을 별도로 걸어두세요. 이 카운터는 2차 안전장치입니다.
const OPENAI_MAX_TOTAL_REQUESTS = 120;

// 2) 무작위 봇의 무단 호출을 막기 위한 간단한 공유 비밀번호. index.html의 GAS_SECRET 값과
//    반드시 동일해야 합니다 — 바꾸려면 두 파일 모두 같은 값으로 함께 수정하세요.
const CLASS_SECRET = 'kbu2026';

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
      return jsonResponse({ ok: false, error: safeErrorMessage('인증 실패: secret 값이 올바르지 않습니다.') });
    }
    checkAndIncrementDailyQuota();

    const report = gradeWithAI(payload);
    logToRoster(payload, report);
    return jsonResponse({ ok: true, report: report });
  } catch (err) {
    return jsonResponse({ ok: false, error: safeErrorMessage(err) });
  }
}

// 채점 실패 메시지는 학생 화면에 그대로 표시되므로, 예산·한도·API 오류 원문 같은 내부 운영 정보는
// 내보내지 않는다. 실제 원인은 Apps Script 실행 로그(보기 → 실행)에만 남겨 관리자가 확인한다.
// 단, 일시적 혼잡 안내는 프론트엔드의 자동 재시도 조건('혼잡')이라 문구를 그대로 통과시킨다.
function safeErrorMessage(err) {
  const raw = String((err && err.message) || err);
  try { Logger.log('채점 실패: ' + raw); } catch (e) { /* 무시 */ }
  if (raw.indexOf('혼잡') !== -1) return raw;
  return '지금은 채점을 받을 수 없습니다. 잠시 후 다시 한번 시도해 보시겠어요?';
}

// [수동 실행 전용] 응시 기록 시트에 필요한 "스프레드시트 생성" 권한을 처음 한 번 승인받기 위한 함수.
// 이 화면(script.google.com) 상단의 함수 선택 목록에서 "setupRosterSheet"를 고른 뒤 ▶ 실행 버튼을 눌러
// 딱 한 번 직접 실행해주세요. 학생이 웹사이트에서 채점을 요청할 때는 승인 창을 띄울 사람이 없어서
// 권한이 없으면 조용히 실패하기 때문에, 반드시 이 함수를 먼저 한 번 수동으로 실행해 권한을 승인해야 합니다.
function setupRosterSheet() {
  const sheet = getOrCreateRosterSheet();
  const ss = sheet.getParent();
  // 이미 만들어져 있던 시트라도, 지금 실행하는 계정과 관리자 계정이 다르면 다시 공유 권한을 부여한다.
  if (ADMIN_EMAIL) {
    try { DriveApp.getFileById(ss.getId()).addEditor(ADMIN_EMAIL); } catch (e) { /* 무시 */ }
  }
  Logger.log('응시 기록 시트 준비 완료: ' + ss.getUrl());
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
      // 이 스크립트를 실행한 계정이 관리자 계정과 다를 수 있으므로(예: 개발용 개인 계정으로 실행),
      // 시트 소유자와 무관하게 관리자 계정에 편집 권한을 명시적으로 부여해둔다.
      try {
        DriveApp.getFileById(ss.getId()).addEditor(ADMIN_EMAIL);
      } catch (e) { /* 이미 같은 계정이거나 공유가 불가능한 경우 무시 */ }
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
      (report.missionNotes || []).filter(function (n) { return n.tier === '노력 필요'; }).map(function (n) { return n.id; }).join(', ')
    ]);
  } catch (e) {
    // 시트 기록 실패(권한, 일시적 오류 등)는 조용히 무시한다.
  }
}

// 남은 채점 예산을 한 줄로 요약한다. 심사 모드(openai)일 때는 누적 상한 기준, 평소(gemini)에는 일일 상한 기준.
function budgetSummary() {
  const props = PropertiesService.getScriptProperties();
  if (ACTIVE_PROVIDER === 'openai') {
    const used = Number(props.getProperty('openaiReqCount_total') || '0');
    return {
      label: '심사용 채점 예산(누적)',
      used: used,
      max: OPENAI_MAX_TOTAL_REQUESTS,
      left: Math.max(0, OPENAI_MAX_TOTAL_REQUESTS - used),
      text: used + ' / ' + OPENAI_MAX_TOTAL_REQUESTS + '회 사용 · 잔여 ' + Math.max(0, OPENAI_MAX_TOTAL_REQUESTS - used) + '회'
    };
  }
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Seoul', 'yyyy-MM-dd');
  const used = Number(props.getProperty('reqCount_' + today) || '0');
  return {
    label: '오늘 채점 횟수',
    used: used,
    max: MAX_DAILY_REQUESTS,
    left: Math.max(0, MAX_DAILY_REQUESTS - used),
    text: used + ' / ' + MAX_DAILY_REQUESTS + '회 사용 · 오늘 잔여 ' + Math.max(0, MAX_DAILY_REQUESTS - used) + '회'
  };
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 지난 7일간 응시 기록을 요약해 관리자에게 메일로 보낸다. setupWeeklyDigestTrigger()로 등록한
// 트리거가 매주 월요일에 이 함수를 자동으로 실행한다. 활동이 없던 주에도 "0건"으로 보내서
// 트리거 자체가 살아있는지 확인할 수 있게 한다.
// 학생용 학습 보고서와 비슷하게 "누가 어떤 등급을 받았는지" 한눈에 보이는 표로 구성하되,
// 제목·톤은 학생이 아니라 관리자가 보는 것임을 분명히 한다.
function sendWeeklyDigest() {
  if (!ADMIN_EMAIL) return;
  const sheet = getOrCreateRosterSheet();
  const values = sheet.getDataRange().getValues();
  const rows = values.slice(1); // 헤더 제외: [날짜,시각,이름,학번,코어미션완료,종합등급,총평,보완필요미션]
  const tz = Session.getScriptTimeZone() || 'Asia/Seoul';
  const now = new Date();
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const recent = rows.filter(function (r) {
    const d = new Date(r[0]);
    return !isNaN(d) && d >= weekAgo;
  });

  const tierCounts = {};
  recent.forEach(function (r) {
    const tier = r[5] || '(미상)';
    tierCounts[tier] = (tierCounts[tier] || 0) + 1;
  });
  const tierSummary = Object.keys(tierCounts).map(function (t) { return t + ' ' + tierCounts[t] + '명'; }).join(' · ') || '활동 없음';
  const periodLabel = Utilities.formatDate(weekAgo, tz, 'M월 d일') + ' ~ ' + Utilities.formatDate(now, tz, 'M월 d일');
  const rosterUrl = sheet.getParent().getUrl();
  const budget = budgetSummary();

  const rowsHtml = recent.map(function (r) {
    return '<tr style="border-bottom:1px solid #e5e5e0">' +
      '<td style="padding:6px 8px;white-space:nowrap">' + escHtml(r[0]) + ' ' + escHtml(r[1]) + '</td>' +
      '<td style="padding:6px 8px">' + escHtml(r[2]) + '</td>' +
      '<td style="padding:6px 8px">' + escHtml(r[3]) + '</td>' +
      '<td style="padding:6px 8px">' + escHtml(r[4]) + '</td>' +
      '<td style="padding:6px 8px"><b>' + escHtml(r[5]) + '</b></td>' +
      '<td style="padding:6px 8px;color:#62676a">' + escHtml(r[7]) + '</td>' +
      '</tr>';
  }).join('');

  const htmlBody =
    '<div style="font-family:-apple-system,Arial,sans-serif;max-width:640px">' +
    '<div style="background:linear-gradient(135deg,#173f39,#2f675d);color:#fff;border-radius:12px;padding:16px 18px;margin-bottom:14px">' +
    '<div style="font-size:11px;letter-spacing:.08em;color:#bfe0d6;text-transform:uppercase;font-weight:800">Architecture AX Expert · 관리자 전용 주간 요약</div>' +
    '<div style="font-size:18px;font-weight:800;margin-top:4px">' + periodLabel + '</div>' +
    '</div>' +
    '<p style="font-size:13px;color:#333">이번 주 셀프평가 요청 <b>' + recent.length + '건</b> · 등급 분포: ' + tierSummary + '</p>' +
    '<p style="font-size:12.5px;color:' + (budget.left <= 20 ? '#b84444' : '#62676a') + ';margin:-6px 0 12px">' +
    escHtml(budget.label) + ': <b>' + escHtml(budget.text) + '</b>' + (budget.left <= 20 ? ' — 잔여량이 얼마 남지 않았습니다.' : '') + '</p>' +
    (recent.length
      ? '<table style="width:100%;border-collapse:collapse;font-size:12.5px"><tr style="background:#f2f6f4;text-align:left">' +
        '<th style="padding:6px 8px">일시</th><th style="padding:6px 8px">이름</th><th style="padding:6px 8px">학번</th>' +
        '<th style="padding:6px 8px">완료</th><th style="padding:6px 8px">등급</th><th style="padding:6px 8px">보완 미션</th></tr>' + rowsHtml + '</table>'
      : '<p style="color:#888;font-size:13px">이번 주는 활동이 없었습니다.</p>') +
    '<p style="margin-top:16px;font-size:12px;color:#888">전체 명단(관리자 전용 시트): <a href="' + rosterUrl + '">' + rosterUrl + '</a></p>' +
    '</div>';

  const plainBody = '[관리자 전용] 지난 7일간(' + periodLabel + ') 셀프평가 요청: ' + recent.length + '건\n등급 분포: ' + tierSummary +
    '\n' + budget.label + ': ' + budget.text + '\n\n전체 명단: ' + rosterUrl;
  const dateLabel = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  MailApp.sendEmail({ to: ADMIN_EMAIL, subject: '[AX Expert 관리자] 주간 채점 현황 (' + dateLabel + ')', body: plainBody, htmlBody: htmlBody });
}

// [수동 실행 전용] 매주 월요일 오전에 sendWeeklyDigest()가 자동 실행되도록 트리거를 등록한다.
// script.google.com 상단 함수 선택 목록에서 "setupWeeklyDigestTrigger"를 고른 뒤 ▶ 실행 버튼을
// 딱 한 번 눌러주세요(재실행해도 중복 등록되지 않도록 기존 트리거를 먼저 지우고 새로 만듭니다).
// 정확히 9시 정각이 아니라 9~10시 사이 임의 시각에 실행되며(Apps Script 트리거의 특성),
// 프로젝트 설정의 시간대가 Asia/Seoul로 되어 있는지 함께 확인하세요.
function setupWeeklyDigestTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendWeeklyDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendWeeklyDigest')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .create();
  Logger.log('매주 월요일 오전(9~10시경) 주간 요약 메일 트리거가 등록되었습니다.');
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

// 심사 기간(30일) 전체 누적 OpenAI 요청 수를 세어 OPENAI_MAX_TOTAL_REQUESTS를 넘으면 예외를 던진다.
// 날짜별로 리셋되는 checkAndIncrementDailyQuota와 달리, 이건 기간 전체 누적치다.
function checkAndIncrementOpenAIQuota() {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const key = 'openaiReqCount_total';
    const count = Number(props.getProperty(key) || '0');
    if (count >= OPENAI_MAX_TOTAL_REQUESTS) {
      throw new Error('심사용 채점 예산 한도(' + OPENAI_MAX_TOTAL_REQUESTS + '회)를 모두 사용했습니다. 관리자에게 문의하세요.');
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
const IMAGE_FIELD_KEYS = ['imageData', 'slideImage1', 'slideImage2', 'slideImage3', 'slideImage4', 'slideImage5', 'refImageStart', 'refImageMiddle', 'refImageFinal', 'refImageMcp', 'cmpImageBefore', 'cmpImageAfter', 'cmpImageFinal'];
// 안전장치: 이미지 1장당 base64 용량 상한(약 1.2MB 원본 기준). 이보다 크면 손상되었거나 비정상 데이터로 보고 건너뛴다.
const MAX_IMAGE_BASE64_CHARS = 1600000;
// 코어 미션 01~09번은 대표 이미지 1장씩(최대 9장)을 모두 검토한다. 10번(발표자료 슬라이드)은
// 건축 사진 관련성 판단 대상이 아니므로 이미지 채점에서 제외한다(buildImageParts 참고).
// (학생이 더 많이 올려도, 초과분은 이미지 없이 텍스트 기준으로만 채점되며 감점 사유가 되지 않는다.)
const MAX_IMAGES_PER_REQUEST = 9;

function hasAnyImage(f) {
  return !!(f && IMAGE_FIELD_KEYS.some(function (k) { return f[k]; }));
}

function buildSummary(payload) {
  const student = payload.student || {};
  const missions = payload.missions || [];
  const core = missions.filter(function (m) { return m.id !== '11' && m.id !== '12'; });
  const completedCount = core.filter(function (m) { return m.completed; }).length;
  const imageMissionCount = missions.filter(function (m) { return m.id !== '10' && hasAnyImage(m.fields); }).length;

  const lines = [];
  lines.push('학생 이름: ' + (student.name || '미기재'));
  lines.push('학번: ' + (student.studentId || '미기재'));
  lines.push('코어 미션(01~10) 완료 개수: ' + completedCount + ' / ' + core.length);
  lines.push('이미지가 첨부된 미션 수(01~09번 기준): ' + imageMissionCount + ' (최대 ' + MAX_IMAGES_PER_REQUEST + '장까지 [미션 NN 첨부 이미지] 라벨과 함께 순서대로 첨부됨. 10번은 이미지 없이 텍스트로만 판단할 것)');
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
    if (!hasField) lines.push('  (기록 없음 — 이미지 첨부 여부와 무관하게 텍스트 기준으로 판단)');
    lines.push('');
  });

  const selfEval = payload.selfEval || {};
  lines.push('[학생 자기평가서 — 학생이 스스로 매긴 점수/근거이며 아직 검증되지 않은 값]');
  CRITERIA.forEach(function (c) {
    const score = selfEval[c.key + '_score'];
    const note = selfEval[c.key + '_note'];
    lines.push('  - ' + c.name + ': 자기 점수 ' + (score !== undefined && score !== '' ? score + '점' : '미기재') + ' / 자기 근거: ' + (note ? note : '(근거 없음)'));
  });
  lines.push('  - 종합 소감: ' + (selfEval.overall ? selfEval.overall : '(미기재)'));
  lines.push('');

  return lines.join('\n');
}

// 미션별 첨부 이미지를 제공자 중립적인 형태({missionId, mimeType, base64})로 모은다.
// 미션당 대표 이미지 1장만 사용하고, 10번(발표자료 슬라이드)은 건축 사진 관련성 판단 대상이 아니므로 제외한다.
// 코어 미션(01~09)을 보너스(11~12)보다 우선 포함하고, 전체 개수는 MAX_IMAGES_PER_REQUEST로 제한한다.
function collectMissionImages(payload) {
  const missions = payload.missions || [];
  const images = [];
  const ordered = missions.slice().filter(function (m) { return m.id !== '10'; }).sort(function (a, b) {
    const aBonus = (a.id === '11' || a.id === '12') ? 1 : 0;
    const bBonus = (b.id === '11' || b.id === '12') ? 1 : 0;
    return aBonus - bBonus;
  });
  ordered.forEach(function (m) {
    if (images.length >= MAX_IMAGES_PER_REQUEST) return;
    const f = m.fields || {};
    for (let i = 0; i < IMAGE_FIELD_KEYS.length; i++) {
      const dataUrl = f[IMAGE_FIELD_KEYS[i]];
      if (!dataUrl || typeof dataUrl !== 'string') continue;
      const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!match) continue;
      const mimeType = match[1];
      const base64 = match[2];
      if (base64.length > MAX_IMAGE_BASE64_CHARS) continue; // 비정상적으로 큰 데이터는 건너뛴다
      images.push({ missionId: m.id, mimeType: mimeType, base64: base64 });
      break; // 미션당 대표 이미지 1장만 사용
    }
  });
  return images;
}

// Gemini 멀티모달 파트(라벨 텍스트 + inlineData) 형식으로 변환한다.
function buildImagePartsGemini(images) {
  const parts = [];
  images.forEach(function (img) {
    parts.push({ text: '[미션 ' + img.missionId + ' 첨부 이미지]' });
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
  });
  return parts;
}

// OpenAI Responses API의 content 파트(input_text + input_image) 형식으로 변환한다.
// detail:'low'로 고정해 이미 저해상도로 압축된 이미지의 토큰 비용을 추가로 낮춘다.
function buildImagePartsOpenAI(images) {
  const parts = [];
  images.forEach(function (img) {
    parts.push({ type: 'input_text', text: '[미션 ' + img.missionId + ' 첨부 이미지]' });
    parts.push({ type: 'input_image', image_url: 'data:' + img.mimeType + ';base64,' + img.base64, detail: 'low' });
  });
  return parts;
}

// 'fast'(Gemini, 학생 공개용): 이미지는 무관 여부만 가볍게 필터링, 평가는 텍스트 중심 — 속도·비용 우선.
// 'deep'(OpenAI 심사 전용): 이미지를 실제로 관찰해 텍스트와 대조까지 하는 더 꼼꼼한 판단 — 품질 우선.
const IMAGE_RULES_FAST =
  '10) [중요] 프롬프트 뒤에 [미션 NN 첨부 이미지] 라벨과 함께 이미지가 첨부된 경우(01~09번만 해당, 10번은 이미지 없이 텍스트로만 판단), 그 이미지의 용도는 단 하나, "이 미션과 전혀 무관한 이미지를 올리지 않았는지" 확인하는 필터다. ' +
  '이미지는 속도를 위해 저해상도로 전송되니 세부 디자인 품질이나 텍스트 설명과의 정밀한 일치 여부는 판단하지 말고, 큰 범주(건축·공간·인테리어·도면·모델링·건물 관련인지)만 확인해라. ' +
  '건축·공간과 명백히 무관한 이미지(예: 사람 얼굴 셀카, 음식, 동물, 밈, 미션 주제와 전혀 상관없는 사진)일 때만 해당 미션 관련 criteria(특히 "사전 관찰", "기록의 구체성")를 "노력 필요"로 낮추고, overallComment에 "이미지가 미션 주제와 맞지 않습니다"라고 짧게 언급해라. ' +
  '이미지가 건축·공간 관련 내용이 맞다면 그 이상 따지지 말고 정상적으로 텍스트 기준을 그대로 적용해라.\n\n' +
  '11) [중요] 이미지는 어디까지나 "완전히 무관한 이미지는 아닌지" 확인하는 참고 자료일 뿐, 그 자체가 평가 근거가 될 수 없다. ' +
  '이미지가 첨부된 미션이라도 학생의 텍스트가 그 이미지 속 건물/공간이 무엇인지, 무엇을 관찰했는지를 전혀 언급하지 않거나 어떤 이미지에나 붙일 수 있는 뻔한 문장뿐이라면, ' +
  '이미지가 있다는 이유로 후하게 평가하지 말고 "사전 관찰"과 "기록의 구체성"을 낮게 평가해라. 평가는 반드시 학생이 글로 남긴 관찰과 판단의 구체성에 근거해야 한다.\n\n';

const IMAGE_RULES_DEEP =
  '10) [중요] 프롬프트 뒤에 [미션 NN 첨부 이미지] 라벨과 함께 이미지가 첨부된 경우(01~09번만 해당, 10번은 텍스트로만 판단), 이번 심사에서는 이미지를 실제로 꼼꼼히 관찰하고 판단 근거로 적극 사용해라. ' +
  '건축·공간과 명백히 무관한 이미지(예: 사람 얼굴 셀카, 음식, 동물, 밈)라면 관련 criteria(특히 "사전 관찰", "기록의 구체성")를 "노력 필요"로 낮추고 이유를 언급해라. ' +
  '무관하지 않다면, 이미지에 실제로 드러나는 매스·재료·입면·공간 구성·완성도를 관찰하고, 학생이 텍스트(STEP 기록 등)에 적은 관찰·판단 내용과 이미지가 실제로 일치하는지 대조해라.\n\n' +
  '11) [중요] 텍스트와 이미지 내용이 뚜렷이 다르면(예: 텍스트는 "유리와 콘크리트"라 했는데 이미지는 전혀 다른 재료·형태) 이는 신뢰성 문제이므로 "근거 대조" 기준을 낮추고 근거를 comment에 짧게 밝혀라. ' +
  '가능하면 각 criteria의 comment에 이미지에서 실제로 관찰한 구체적 요소를 최소 한 곳 언급해서, 텍스트만이 아니라 이미지를 실제로 보고 판단했다는 근거를 남겨라. ' +
  '단, 모든 comment는 기준당 1~2문장으로 간결하게 유지해라 — 장황한 서술은 평가 시간을 늘리므로 금지한다.\n\n';

// 두 제공자(Gemini/OpenAI)가 공유하는 채점 지시문. 핵심 채점 기준(1~9)은 동일하고,
// 이미지 처리 방식(10~11)만 mode('fast'|'deep')에 따라 달라진다.
function buildGradingPrompt(summary, mode) {
  const criteriaList = CRITERIA.map(function (c) { return '- ' + c.name; }).join('\n');
  const tierOptions = '"매우 잘함" | "잘함" | "보통" | "노력 필요"';
  const imageRules = mode === 'deep' ? IMAGE_RULES_DEEP : IMAGE_RULES_FAST;
  return (
    '너는 건축·공간디자인 AI 활용 수업의 채점 조교다. 아래 학생의 미션 실습 기록을 읽고 참고용 피드백 카드를 작성해라.\n\n' +
    '중요한 규칙:\n' +
    '1) 반드시 세부 점수나 숫자 점수를 매기지 말고, 아래 4단계 등급 중 하나로만 평가해라: ' + tierOptions + '\n' +
    '2) 미션 01~10(코어 스튜디오)만 아래 5개 기준으로 등급을 매기고, 그것을 종합해 전체 등급(overallTier)도 하나 정해라.\n' +
    '3) 미션 11(공공건축 MCP 분석)과 미션 12(AI 건축 모델링 검증)는 "도전미션"이며 정규 등급 평가에는 절대 포함하지 않는다(코멘트에서도 "보너스"가 아니라 "도전미션"으로 불러라). ' +
    '완성된 결과물(실제 MCP 실행 화면이나 완성된 영상)은 요구하지 않는다 — 스크린샷과 판단 기록만으로 충분하다. ' +
    '다만 이 두 미션은 가점과 직결되므로 completed:true는 학생이 자기 언어로 남긴 판단 과정이 실제로 확인될 때만 부여해라. ' +
    '즉 검색 질문이나 공간 의도가 구체적으로 적혀 있고, 무엇을 확인했는지 또는 어떤 오류를 발견했는지, 그래서 무엇을 채택·수정·거부했는지가 드러나야 한다. ' +
    '기록이 전혀 없거나, 한두 단어("함", "완료", "네") 수준이거나, 실습 안내문을 거의 그대로 옮겨 적었거나, 어느 미션에나 붙일 수 있는 뻔한 문장뿐이면 ' +
    '칸이 채워져 있어도 completed:false로 판정하고 그 이유를 comment에 한 문장으로 밝혀라.\n' +
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
    imageRules +
    '12) [자기평가서 대조] 학생이 자기평가서에서 스스로 매긴 점수(20=매우 잘함, 15=잘함, 10=보통, 5 이하=노력 필요)와 네가 criteria에서 독립적으로 매긴 등급을 비교해라. ' +
    '자기 점수가 실제 미션 기록 내용보다 뚜렷이 부풀려져 있거나(예: 기록은 부실한데 전부 20점), 자기평가의 근거나 종합소감이 비어있거나 형식적이거나(예: "잘함", "네") 미션 기록 문장을 그대로 복사한 것처럼 보이면 ' +
    'selfEvalCheck.mismatch를 true로 하고 이유를 selfEvalCheck.note에 1문장으로 짧게 적어라. 자기평가가 실제 기록과 대체로 일치하고 근거도 구체적이면 mismatch는 false, note는 빈 문자열로 남겨라.\n\n' +
    '채점 기준 (미션 01~10 전용):\n' + criteriaList + '\n\n' +
    '반드시 아래 JSON 형식으로만 응답하고 다른 텍스트는 절대 포함하지 마라 (숫자 점수 필드를 절대 추가하지 마라):\n' +
    '{"completedCount":"N/10 형식의 문자열","overallTier":' + tierOptions + ',"overallComment":"총평 2문장 이내","criteria":[{"name":"기준명","tier":' + tierOptions + ',"comment":"코멘트 1문장"}],' +
    '"missionNotes":[{"id":"01","tier":' + tierOptions + ',"note":"15자 내외 짧은 이유"}],' +
    '"selfEvalCheck":{"mismatch":true 또는 false,"note":"불일치 이유 1문장, 없으면 빈 문자열"},' +
    '"bonusMissions":[{"id":"11","label":"11번 · 공공건축 MCP 분석","completed":true 또는 false,"comment":"코멘트 1문장"},{"id":"12","label":"12번 · AI 건축 모델링 검증","completed":true 또는 false,"comment":"코멘트 1문장"}]}\n' +
    '(criteria 배열은 반드시 위 5개 기준 각각에 대해 하나씩, 총 5개 항목. missionNotes는 반드시 미션 "01"~"10" 각각 하나씩 총 10개 항목을 빠짐없이 채워라 — note는 그 미션에서 실제로 관찰한 근거나 부족한 이유를 구체적으로 15자 내외로 적고 "잘했습니다"처럼 근거 없는 말은 금지. bonusMissions는 반드시 11번, 12번 각각 하나씩 총 2개 항목)\n\n' +
    '학생 기록:\n' + summary
  );
}

// OpenAI Structured Outputs용 JSON 스키마. criteria/bonusMissions 항목 형식을 강제해 응답 파싱 실패를 막는다.
const GRADING_JSON_SCHEMA = {
  type: 'object',
  properties: {
    completedCount: { type: 'string' },
    overallTier: { type: 'string', enum: ['매우 잘함', '잘함', '보통', '노력 필요'] },
    overallComment: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          tier: { type: 'string', enum: ['매우 잘함', '잘함', '보통', '노력 필요'] },
          comment: { type: 'string' }
        },
        required: ['name', 'tier', 'comment'],
        additionalProperties: false
      }
    },
    missionNotes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tier: { type: 'string', enum: ['매우 잘함', '잘함', '보통', '노력 필요'] },
          note: { type: 'string' }
        },
        required: ['id', 'tier', 'note'],
        additionalProperties: false
      }
    },
    selfEvalCheck: {
      type: 'object',
      properties: {
        mismatch: { type: 'boolean' },
        note: { type: 'string' }
      },
      required: ['mismatch', 'note'],
      additionalProperties: false
    },
    bonusMissions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          completed: { type: 'boolean' },
          comment: { type: 'string' }
        },
        required: ['id', 'label', 'completed', 'comment'],
        additionalProperties: false
      }
    }
  },
  required: ['completedCount', 'overallTier', 'overallComment', 'criteria', 'missionNotes', 'selfEvalCheck', 'bonusMissions'],
  additionalProperties: false
};

// ACTIVE_PROVIDER 설정에 따라 Gemini 또는 OpenAI(GPT-5.6 Terra)로 채점 요청을 분기한다.
function gradeWithAI(payload) {
  const summary = buildSummary(payload);
  const isOpenAI = ACTIVE_PROVIDER === 'openai';
  const prompt = buildGradingPrompt(summary, isOpenAI ? 'deep' : 'fast');
  const images = collectMissionImages(payload);
  if (isOpenAI) {
    return gradeWithOpenAI(prompt, images);
  }
  return gradeWithGemini(prompt, images);
}

function gradeWithGemini(prompt, images) {
  const apiKey = getApiKey('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY가 스크립트 속성에 설정되지 않았습니다. DEPLOY.md를 참고해 먼저 설정하세요.');
  }

  const imageParts = buildImagePartsGemini(images);
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + apiKey;
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
      throw new Error('AI 서버가 지금 일시적으로 혼잡합니다. 잠시 후 다시 한번 시도해 보시겠어요?');
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

// 대회 심사 전용: GPT-5.6 Terra(OpenAI Responses API)로 채점 요청을 보낸다.
function gradeWithOpenAI(prompt, images) {
  const apiKey = getApiKey('OPENAI_API_KEY');
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY가 스크립트 속성에 설정되지 않았습니다. ACTIVE_PROVIDER를 openai로 쓰려면 먼저 설정하세요.');
  }
  checkAndIncrementOpenAIQuota();

  const imageParts = buildImagePartsOpenAI(images);
  const content = [{ type: 'input_text', text: prompt }].concat(imageParts);
  const url = 'https://api.openai.com/v1/responses';
  const body = {
    model: OPENAI_MODEL,
    input: [{ role: 'user', content: content }],
    reasoning: { effort: OPENAI_REASONING_EFFORT },
    text: { format: { type: 'json_schema', name: 'grading_report', schema: GRADING_JSON_SCHEMA } },
    max_output_tokens: 8000
  };

  // Gemini와 동일한 방식으로, 일시적 혼잡(429/500/503)에는 점점 더 길게 쉬었다가 자동 재시도한다.
  const RETRY_STATUSES = [503, 429, 500];
  const MAX_ATTEMPTS = 4;
  let status, text;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + apiKey },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    status = res.getResponseCode();
    text = res.getContentText();
    if (status === 200) break;
    if (RETRY_STATUSES.indexOf(status) === -1 || attempt === MAX_ATTEMPTS) break;
    Utilities.sleep(1500 * Math.pow(2, attempt - 1));
  }

  if (status !== 200) {
    if (RETRY_STATUSES.indexOf(status) !== -1) {
      throw new Error('AI 서버가 지금 일시적으로 혼잡합니다. 잠시 후 다시 한번 시도해 보시겠어요?');
    }
    throw new Error('OpenAI API 오류 (' + status + '): ' + text.substring(0, 300));
  }

  const data = JSON.parse(text);
  const messageItem = (data.output || []).filter(function (o) { return o.type === 'message'; })[0];
  const textItem = messageItem && (messageItem.content || []).filter(function (c) { return c.type === 'output_text'; })[0];
  const raw = textItem && textItem.text;
  if (!raw) throw new Error('AI 응답을 읽을 수 없습니다 (reasoning에 출력 토큰을 모두 사용했을 수 있습니다 — max_output_tokens를 늘려보세요).');

  return JSON.parse(raw);
}
