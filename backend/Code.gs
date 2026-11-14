/**
 * Architecture AX Expert - AI 채점 백엔드 (Google Apps Script)
 * 2026-11-14 Gemini 기본 제공자 갱신본. 기존 Apps Script 프로젝트의 배포를 새 버전으로 갱신한다.
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
const GEMINI_MODEL = 'gemini-3.5-flash-lite';

// === 채점 제공자 전환 스위치 ===
// 각 제공자의 API 요금·계정 접근권한은 운영자가 확인한다.
// OpenAI는 한국시간 일정에 따라 모델만 전환한다. Gemini나 고가 모델로 자동 우회하지 않는다.
const ACTIVE_PROVIDER = 'gemini'; // 'gemini' | 'openai'

// --- OpenAI Responses API 설정 ---
// 해당 모델을 사용할 수 있는 API 프로젝트의 키와 사용 가능한 결제/크레딧이 필요하다.
// 계정별 모델 접근권한은 testOpenAIConnection()을 직접 실행하여 확인한다.
const OPENAI_MODEL = 'gpt-6-astra';
const OPENAI_REASONING_EFFORT = 'low';
const OPENAI_ECONOMY_MODEL = 'gpt-6-luna';
const OPENAI_ECONOMY_REASONING_EFFORT = 'low';
const OPENAI_MAX_MONTHLY_REQUESTS = 120;

// [평가 운영기간] 한국시간 2026-11-13 00:00부터 2026-12-31 23:59:59까지 Astra low.
// 종료 시각(exclusive)인 2027-01-01 00:00부터 Luna low와 한국시간 월별 한도를 적용한다.
// 기존 기간 ID는 사용량 보존을 위해 유지한다. 1월 이후는 월별 전용 카운터를 사용한다.
const OPENAI_PERIOD_ID = '20261113_20261213';
const OPENAI_PERIOD_START = '2026-11-13T00:00:00+09:00';
const OPENAI_PERIOD_END_EXCLUSIVE = '2027-01-01T00:00:00+09:00';
const OPENAI_MAX_PERIOD_REQUESTS = 120;
const QUOTA_TIME_ZONE = 'Asia/Seoul';

// 실제 API 요청 시도마다 차감한다. 재시도·실패·관리자 연결시험도 포함한다.
// 요청 수 상한은 금액 상한이 아니다. 요금과 OpenAI 계정의 사용 한도도 별도로 확인한다.
// 기존 openaiReqCount_total은 보존하며 이번 기간의 차단 판단에는 사용하지 않는다.

// 2) 무작위 봇의 무단 호출을 막기 위한 간단한 공유 비밀번호. index.html의 GAS_SECRET 값과
//    반드시 동일해야 합니다 — 바꾸려면 두 파일 모두 같은 값으로 함께 수정하세요.
const CLASS_SECRET = 'kbu2026';

// 3) 하루 최대 횟수. OpenAI는 실제 API 시도마다, Gemini는 기존처럼 채점 요청마다 센다.
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
  const requestId = createRequestId();
  try {
    let payload;
    try {
      payload = JSON.parse(e && e.postData && e.postData.contents);
    } catch (parseError) {
      throw gradingError('INVALID_REQUEST');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw gradingError('INVALID_REQUEST');
    }

    if (CLASS_SECRET && payload.secret !== CLASS_SECRET) {
      throw gradingError('AUTH_FAILED');
    }

    // 1장 결과 저장 신호는 AI를 호출하지 않으므로 채점 횟수 한도에서 제외한다.
    if (payload.action === 'certificateSaved') {
      markCertificateSaved(payload);
      return jsonResponse({ ok: true });
    }

    // OpenAI의 일일/기간 한도는 각 실제 API 시도 직전에 함께 검사·차감한다.
    if (ACTIVE_PROVIDER !== 'openai') checkAndIncrementDailyQuota();

    const report = gradeWithAI(payload);
    logToRoster(payload, report);
    return jsonResponse({ ok: true, report: report });
  } catch (err) {
    const code = classifyGradingError(err);
    logSafeGradingError(err, code, requestId);
    return jsonResponse({ ok: false, error: safeErrorMessage(err), code: code, requestId: requestId });
  }
}

// 오류 원문·인증값·학생 입력은 응답과 로그에 남기지 않는다.
// 학생은 code/requestId를 관리자에게 전달하고, 관리자는 같은 requestId의 운영 로그를 확인한다.
const GRADING_ERROR_MESSAGES = {
  AUTH_FAILED: '요청 인증을 확인하지 못했습니다. 사이트와 채점 서버의 연결 설정을 관리자에게 알려 주세요.',
  CONFIG_MISSING: 'AI 진단 운영 설정이 아직 완료되지 않았습니다. 관리자에게 오류 코드를 전달해 주세요.',
  CONFIG_INVALID: 'AI 운영기간 또는 요청 횟수 설정을 확인해야 합니다. 관리자에게 오류 코드를 전달해 주세요.',
  QUOTA_REACHED: '현재 AI 진단 이용 한도에 도달했습니다. 관리자 확인 후 다시 이용해 주세요.',
  PERIOD_NOT_STARTED: 'AI 진단 운영기간이 아직 시작되지 않았습니다. 관리자에게 운영일정을 확인해 주세요.',
  PERIOD_EXPIRED: 'AI 요청의 운영기간이 바뀌었습니다. 잠시 후 다시 요청해 주세요.',
  PERIOD_QUOTA_REACHED: '이번 운영기간의 AI 요청 횟수를 모두 사용했습니다. 관리자에게 횟수 한도를 확인해 주세요.',
  DAILY_QUOTA_REACHED: '오늘의 AI 요청 횟수를 모두 사용했습니다. 다음 날 또는 관리자 확인 후 다시 이용해 주세요.',
  UPSTREAM_AUTH_ERROR: 'AI 서비스 API 키 인증을 확인하지 못했습니다. 관리자에게 오류 코드를 전달해 주세요.',
  UPSTREAM_PERMISSION_ERROR: 'AI 서비스의 프로젝트 또는 모델 이용 권한을 확인해야 합니다. 관리자에게 오류 코드를 전달해 주세요.',
  UPSTREAM_MODEL_ERROR: '지정한 AI 모델을 찾거나 사용할 수 없습니다. 관리자에게 모델 이름과 접근권한 확인을 요청해 주세요.',
  UPSTREAM_BILLING_LIMIT: 'AI 서비스의 크레딧 또는 결제·사용 한도를 확인해야 합니다. 관리자에게 오류 코드를 전달해 주세요.',
  UPSTREAM_REQUEST_ERROR: 'AI 서비스가 요청 형식을 수락하지 않았습니다. 관리자에게 모델·요청 설정 확인을 요청해 주세요.',
  UPSTREAM_BUSY: 'AI 서비스가 일시적으로 혼잡합니다. 잠시 후 직접 다시 시도해 주세요.',
  UPSTREAM_ERROR: 'AI 서비스 연결에서 오류가 발생했습니다. 관리자에게 오류 코드와 요청 번호를 전달해 주세요.',
  INVALID_AI_RESPONSE: 'AI 응답 형식을 확인하지 못했습니다. 학습 기록은 유지되며 관리자 확인이 필요합니다.',
  INVALID_REQUEST: '요청 형식을 확인하지 못했습니다. 학습 기록을 백업한 뒤 페이지를 새로 열어 주세요.',
  INTERNAL_ERROR: '지금은 채점을 받을 수 없습니다. 관리자에게 오류 코드와 요청 번호를 전달해 주세요.'
};

function createRequestId() {
  try { return Utilities.getUuid(); } catch (e) {
    return 'review-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
}

function gradingError(code, status, provider) {
  const safeCode = Object.prototype.hasOwnProperty.call(GRADING_ERROR_MESSAGES, code) ? code : 'INTERNAL_ERROR';
  const err = new Error(GRADING_ERROR_MESSAGES[safeCode]);
  err.gradingCode = safeCode;
  if (Number.isFinite(status)) err.upstreamStatus = status;
  if (provider === 'openai' || provider === 'gemini') err.upstreamProvider = provider;
  return err;
}

function classifyGradingError(err) {
  const code = err && err.gradingCode;
  return Object.prototype.hasOwnProperty.call(GRADING_ERROR_MESSAGES, code) ? code : 'INTERNAL_ERROR';
}

function safeErrorMessage(err) {
  return GRADING_ERROR_MESSAGES[classifyGradingError(err)];
}

function logSafeGradingError(err, code, requestId) {
  const entry = { requestId: requestId, code: code, provider: ACTIVE_PROVIDER };
  if (err && Number.isFinite(err.upstreamStatus)) entry.upstreamStatus = err.upstreamStatus;
  if (safeUpstreamCode(err)) entry.upstreamCode = safeUpstreamCode(err);
  try { Logger.log(JSON.stringify(entry)); } catch (e) { /* 로그 실패는 응답에 영향 없음 */ }
}

// 관리자에게 전달해도 되는 고정 오류 식별자만 허용한다. 임의 code/message는 노출하지 않는다.
const SAFE_UPSTREAM_CODES = [
  'invalid_api_key', 'permission_denied', 'model_not_found', 'invalid_request_error',
  'rate_limit_exceeded', 'insufficient_quota', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
  'credit_balance_exhausted', 'billing_hard_limit_reached', 'billing_not_active'
];

function safeUpstreamCode(err) {
  const code = err && err.upstreamCode;
  return SAFE_UPSTREAM_CODES.indexOf(code) !== -1 ? code : null;
}

// API 오류 내용은 분류에만 사용하고 그대로 반환하거나 기록하지 않는다.
function upstreamError(provider, status, responseText) {
  let upstreamCode = '';
  try {
    const parsed = JSON.parse(responseText);
    upstreamCode = String(parsed && parsed.error && (parsed.error.code || parsed.error.status) || '');
    if (provider === 'gemini' && parsed && parsed.error) {
      const details = Array.isArray(parsed.error.details) ? parsed.error.details : [];
      const authFailure = details.some(function (detail) {
        return detail && detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
          ['API_KEY_INVALID', 'API_KEY_EXPIRED'].indexOf(detail.reason) !== -1;
      });
      // Gemini의 잘못된 키는 HTTP 400으로도 온다. 고정 식별자만 분류하고 원문은 보관하지 않는다.
      if (authFailure || parsed.error.status === 'UNAUTHENTICATED') upstreamCode = 'invalid_api_key';
      else if (parsed.error.status === 'PERMISSION_DENIED' || parsed.error.status === 'FAILED_PRECONDITION') upstreamCode = 'permission_denied';
      else if (parsed.error.status === 'NOT_FOUND') upstreamCode = 'model_not_found';
      else if (parsed.error.status === 'RESOURCE_EXHAUSTED') upstreamCode = status === 402 ? 'credit_balance_exhausted' : 'rate_limit_exceeded';
      else if (parsed.error.status === 'INVALID_ARGUMENT') upstreamCode = 'invalid_request_error';
    }
  } catch (e) { /* JSON이 아닌 상류 응답도 안전하게 분류한다. */ }
  function tagged(error) {
    if (SAFE_UPSTREAM_CODES.indexOf(upstreamCode) !== -1) error.upstreamCode = upstreamCode;
    return error;
  }
  const quotaCodes = ['insufficient_quota', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded', 'credit_balance_exhausted', 'billing_hard_limit_reached', 'billing_not_active'];
  if (quotaCodes.indexOf(upstreamCode) !== -1) return tagged(gradingError('UPSTREAM_BILLING_LIMIT', status, provider));
  if (status === 401 || (provider === 'gemini' && upstreamCode === 'invalid_api_key')) return tagged(gradingError('UPSTREAM_AUTH_ERROR', status, provider));
  if (status === 403 || (provider === 'gemini' && upstreamCode === 'permission_denied')) return tagged(gradingError('UPSTREAM_PERMISSION_ERROR', status, provider));
  if (status === 404 || upstreamCode === 'model_not_found') return tagged(gradingError('UPSTREAM_MODEL_ERROR', status, provider));
  if (status === 400 || status === 422) return tagged(gradingError('UPSTREAM_REQUEST_ERROR', status, provider));
  if ([429, 500, 503].indexOf(status) !== -1) return tagged(gradingError('UPSTREAM_BUSY', status, provider));
  return tagged(gradingError('UPSTREAM_ERROR', status, provider));
}

function parseGradingResponse(raw) {
  let report;
  try { report = JSON.parse(raw); } catch (e) { throw gradingError('INVALID_AI_RESPONSE'); }
  if (!report || typeof report !== 'object' || Array.isArray(report) ||
      typeof report.completedCount !== 'string' || typeof report.overallTier !== 'string' ||
      typeof report.overallComment !== 'string' || !Array.isArray(report.criteria) ||
      !Array.isArray(report.missionNotes) || !Array.isArray(report.bonusMissions) ||
      !report.selfEvalCheck || typeof report.selfEvalCheck.mismatch !== 'boolean') {
    throw gradingError('INVALID_AI_RESPONSE');
  }
  return report;
}

function parseApiEnvelope(raw) {
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid envelope');
    return data;
  } catch (e) {
    throw gradingError('INVALID_AI_RESPONSE');
  }
}

// [관리자 수동 실행 전용] 설정 존재 여부와 카운터만 확인한다.
// 외부 API, 메일, 스프레드시트 작성, 카운터 증가를 수행하지 않는다. 웹 doPost에서 호출하지 않는다.
function diagnoseConfiguration() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const today = Utilities.formatDate(now, QUOTA_TIME_ZONE, 'yyyy-MM-dd');
  const period = safePeriodDiagnostic(undefined, now);
  const status = {
    sourceVersion: 'api-gemini-default-2026-11-14-v27',
    provider: ACTIVE_PROVIDER,
    model: ACTIVE_PROVIDER === 'openai' ? (period.model || null) : GEMINI_MODEL,
    reasoningEffort: ACTIVE_PROVIDER === 'openai' ? (period.reasoningEffort || null) : null,
    phase: ACTIVE_PROVIDER === 'openai' ? (period.phase || null) : null,
    keyConfigured: {
      openai: !!getApiKey('OPENAI_API_KEY').trim(),
      gemini: !!getApiKey('GEMINI_API_KEY').trim()
    },
    dailyRequests: counterDiagnostic(props, 'reqCount_' + today, MAX_DAILY_REQUESTS),
    legacyOpenaiTotalRequests: counterDiagnostic(props, 'openaiReqCount_total', null),
    openaiPeriod: period,
    externalApiCalled: false
  };
  status.dailyRequests.date = today;
  status.legacyOpenaiTotalRequests.preserved = true;
  status.legacyOpenaiTotalRequests.usedForCurrentLimit = false;
  Logger.log(JSON.stringify(status));
  return status;
}

// 진단에는 잘못된 속성 값 자체를 내보내지 않고 valid와 고정 오류 코드만 반환한다.
function counterDiagnostic(props, key, max) {
  try {
    if (max !== null) validateQuotaMaximum(max);
    const used = readQuotaCounter(props, key);
    return { used: used, max: max, left: max === null ? null : Math.max(0, max - used), valid: true };
  } catch (e) {
    return { used: null, max: max, left: null, valid: false, code: classifyGradingError(e) };
  }
}

function safePeriodDiagnostic(profile, now) {
  try { return getOpenAIPeriodStatus(now || new Date(), profile); } catch (e) {
    return { status: 'invalid_configuration', allowed: false, code: classifyGradingError(e) };
  }
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
    const headers = ['날짜', '시각', '이름', '학번', '기본미션 완료', '종합 등급', '총평', '보완 필요 미션'];
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

// 응시 기록 시트에서 "결과 저장" 열(I열)의 위치. 기존 시트에는 이 열이 없으므로 처음 기록할 때 헤더를 만든다.
const SAVED_COLUMN = 9;

// 학생이 1장 결과를 인쇄·PDF로 저장하려 한 시각을, 그 학생의 가장 최근 채점 기록 행에 적어둔다.
// 브라우저는 실제 저장 여부를 알려주지 않으므로 "인쇄 창을 연 시점"까지만 기록된다.
function markCertificateSaved(payload) {
  try {
    const student = payload.student || {};
    const name = String(student.name || '');
    const sid = String(student.studentId || '');
    if (!name && !sid) return;

    const sheet = getOrCreateRosterSheet();
    if (!sheet.getRange(1, SAVED_COLUMN).getValue()) {
      sheet.getRange(1, SAVED_COLUMN).setValue('결과 저장')
        .setFontWeight('bold').setBackground('#174c43').setFontColor('#ffffff');
      sheet.setColumnWidth(SAVED_COLUMN, 110);
    }

    const values = sheet.getDataRange().getValues();
    const tz = Session.getScriptTimeZone() || 'Asia/Seoul';
    const stamp = Utilities.formatDate(new Date(), tz, 'MM-dd HH:mm');
    for (let r = values.length - 1; r >= 1; r--) {
      if (String(values[r][2]) === name && String(values[r][3]) === sid) {
        sheet.getRange(r + 1, SAVED_COLUMN).setValue(stamp);
        return;
      }
    }
  } catch (e) {
    // 기록 실패는 조용히 무시한다 — 학생의 인쇄는 이미 진행 중이다.
  }
}

// OpenAI는 현재 평가기간 또는 한국시간 해당 월의 횟수, Gemini는 오늘의 채점 요청 수를 요약한다.
function budgetSummary() {
  const props = PropertiesService.getScriptProperties();
  if (ACTIVE_PROVIDER === 'openai') {
    const period = safePeriodDiagnostic();
    if (period.status === 'invalid_configuration') {
      return { label: 'OpenAI 운영기간', used: null, max: null, left: 0,
        status: period.status, text: '운영기간 또는 횟수 설정 확인 필요' };
    }
    const labels = { active: '이용 가능', not_started: '시작 전', expired: '기간 종료', quota_reached: '횟수 소진' };
    return {
      label: period.phase === 'economy' ? 'OpenAI 이번 달 요청 수' : 'OpenAI 평가기간 요청 수',
      model: period.model,
      used: period.used,
      max: period.max,
      left: period.left,
      status: period.status,
      text: period.used + ' / ' + period.max + '회 사용 · 잔여 ' + period.left + '회 · ' + labels[period.status] +
        ' · 모델: ' + period.model + ' · 다음 기간 시작: ' + period.endExclusive
    };
  }
  const today = Utilities.formatDate(new Date(), QUOTA_TIME_ZONE, 'yyyy-MM-dd');
  const used = readQuotaCounter(props, 'reqCount_' + today);
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
  const rows = values.slice(1); // 헤더 제외: [날짜,시각,이름,학번,기본미션완료,종합등급,총평,보완필요미션]
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
  const savedCount = recent.filter(function (r) { return !!r[SAVED_COLUMN - 1]; }).length;

  const rowsHtml = recent.map(function (r) {
    return '<tr style="border-bottom:1px solid #e5e5e0">' +
      '<td style="padding:6px 8px;white-space:nowrap">' + escHtml(r[0]) + ' ' + escHtml(r[1]) + '</td>' +
      '<td style="padding:6px 8px">' + escHtml(r[2]) + '</td>' +
      '<td style="padding:6px 8px">' + escHtml(r[3]) + '</td>' +
      '<td style="padding:6px 8px">' + escHtml(r[4]) + '</td>' +
      '<td style="padding:6px 8px"><b>' + escHtml(r[5]) + '</b></td>' +
      '<td style="padding:6px 8px;color:#62676a">' + escHtml(r[7]) + '</td>' +
      '<td style="padding:6px 8px;color:' + (r[SAVED_COLUMN - 1] ? '#174c43' : '#b0b3b5') + '">' + (r[SAVED_COLUMN - 1] ? '저장함' : '—') + '</td>' +
      '</tr>';
  }).join('');

  const htmlBody =
    '<div style="font-family:-apple-system,Arial,sans-serif;max-width:640px">' +
    '<div style="background:linear-gradient(135deg,#173f39,#2f675d);color:#fff;border-radius:12px;padding:16px 18px;margin-bottom:14px">' +
    '<div style="font-size:11px;letter-spacing:.08em;color:#bfe0d6;text-transform:uppercase;font-weight:800">Architecture AX Expert · 관리자 전용 주간 요약</div>' +
    '<div style="font-size:18px;font-weight:800;margin-top:4px">' + periodLabel + '</div>' +
    '</div>' +
    '<p style="font-size:13px;color:#333">이번 주 셀프평가 요청 <b>' + recent.length + '건</b> · 결과 저장 <b>' + savedCount + '건</b> · 등급 분포: ' + tierSummary + '</p>' +
    '<p style="font-size:12.5px;color:' + (budget.left <= 20 ? '#b84444' : '#62676a') + ';margin:-6px 0 12px">' +
    escHtml(budget.label) + ': <b>' + escHtml(budget.text) + '</b>' + (budget.left <= 20 ? ' — 잔여량이 얼마 남지 않았습니다.' : '') + '</p>' +
    (recent.length
      ? '<table style="width:100%;border-collapse:collapse;font-size:12.5px"><tr style="background:#f2f6f4;text-align:left">' +
        '<th style="padding:6px 8px">일시</th><th style="padding:6px 8px">이름</th><th style="padding:6px 8px">학번</th>' +
        '<th style="padding:6px 8px">완료</th><th style="padding:6px 8px">등급</th><th style="padding:6px 8px">보완 미션</th>' +
        '<th style="padding:6px 8px">결과 저장</th></tr>' + rowsHtml + '</table>'
      : '<p style="color:#888;font-size:13px">이번 주는 활동이 없었습니다.</p>') +
    '<p style="margin-top:16px;font-size:12px;color:#888">전체 명단(관리자 전용 시트): <a href="' + rosterUrl + '">' + rosterUrl + '</a></p>' +
    '</div>';

  const plainBody = '[관리자 전용] 지난 7일간(' + periodLabel + ') 셀프평가 요청: ' + recent.length + '건 (결과 저장 ' + savedCount + '건)\n등급 분포: ' + tierSummary +
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
  const today = Utilities.formatDate(new Date(), QUOTA_TIME_ZONE, 'yyyy-MM-dd');
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const key = 'reqCount_' + today;
    const count = readQuotaCounter(props, key);
    validateQuotaMaximum(MAX_DAILY_REQUESTS);
    if (count >= MAX_DAILY_REQUESTS) {
      throw gradingError('DAILY_QUOTA_REACHED');
    }
    props.setProperty(key, String(count + 1));
  } finally {
    lock.releaseLock();
  }
}

function validateQuotaMaximum(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw gradingError('CONFIG_INVALID');
}

// 숫자가 아니거나 음수·소수·빈 문자열이면 안전하게 차단한다. 원문은 로그에 남기지 않는다.
function readQuotaCounter(props, key) {
  const raw = props.getProperty(key);
  if (raw === null || raw === undefined) return 0;
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) throw gradingError('CONFIG_INVALID');
  const count = Number(raw);
  if (!Number.isSafeInteger(count)) throw gradingError('CONFIG_INVALID');
  return count;
}

// 명시적인 한국시간 ISO 값만 허용하며 2월30일 같은 자동 보정 날짜도 거부한다.
function parseKoreaTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(value)) {
    throw gradingError('CONFIG_INVALID');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis + 9 * 60 * 60 * 1000).toISOString().slice(0, 19) + '+09:00' !== value) {
    throw gradingError('CONFIG_INVALID');
  }
  return millis;
}

// 모델·추론·한도 기간을 요청 시작 시 한 번 고른다. 날짜는 서버의 한국시간을 기준으로 한다.
// 반환 객체는 서버 내부에서만 만들며 학생 요청으로 모델이나 기간을 지정할 수 없다.
function resolveOpenAIProfile(now) {
  const current = now && typeof now.getTime === 'function' ? now.getTime() : NaN;
  const start = parseKoreaTimestamp(OPENAI_PERIOD_START);
  const switchAt = parseKoreaTimestamp(OPENAI_PERIOD_END_EXCLUSIVE);
  if (start >= switchAt || !Number.isFinite(current) ||
      typeof OPENAI_PERIOD_ID !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(OPENAI_PERIOD_ID)) {
    throw gradingError('CONFIG_INVALID');
  }
  validateQuotaMaximum(OPENAI_MAX_PERIOD_REQUESTS);
  validateQuotaMaximum(OPENAI_MAX_MONTHLY_REQUESTS);
  if (current < switchAt) {
    return {
      phase: 'evaluation', model: OPENAI_MODEL, reasoningEffort: OPENAI_REASONING_EFFORT,
      periodId: OPENAI_PERIOD_ID, periodStart: OPENAI_PERIOD_START,
      periodEndExclusive: OPENAI_PERIOD_END_EXCLUSIVE, maxRequests: OPENAI_MAX_PERIOD_REQUESTS
    };
  }
  const korea = new Date(current + 9 * 60 * 60 * 1000);
  const year = korea.getUTCFullYear();
  const month = korea.getUTCMonth() + 1;
  const monthText = String(month).padStart(2, '0');
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    phase: 'economy', model: OPENAI_ECONOMY_MODEL, reasoningEffort: OPENAI_ECONOMY_REASONING_EFFORT,
    periodId: 'monthly_' + year + monthText,
    periodStart: year + '-' + monthText + '-01T00:00:00+09:00',
    periodEndExclusive: nextYear + '-' + String(nextMonth).padStart(2, '0') + '-01T00:00:00+09:00',
    maxRequests: OPENAI_MAX_MONTHLY_REQUESTS
  };
}

function getOpenAIPeriodStatus(now, selectedProfile) {
  const profile = selectedProfile || resolveOpenAIProfile(now);
  validateQuotaMaximum(profile.maxRequests);
  if (typeof profile.periodId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(profile.periodId)) {
    throw gradingError('CONFIG_INVALID');
  }
  const start = parseKoreaTimestamp(profile.periodStart);
  const end = parseKoreaTimestamp(profile.periodEndExclusive);
  const current = now && typeof now.getTime === 'function' ? now.getTime() : NaN;
  if (start >= end || !Number.isFinite(current)) throw gradingError('CONFIG_INVALID');
  const counterKey = 'openaiReqCount_period_' + profile.periodId;
  const used = readQuotaCounter(PropertiesService.getScriptProperties(), counterKey);
  const status = current < start ? 'not_started' : current >= end ? 'expired' :
    used >= profile.maxRequests ? 'quota_reached' : 'active';
  return {
    id: profile.periodId, counterKey: counterKey,
    phase: profile.phase, model: profile.model, reasoningEffort: profile.reasoningEffort,
    start: profile.periodStart, endExclusive: profile.periodEndExclusive, timeZone: QUOTA_TIME_ZONE,
    used: used, max: profile.maxRequests, left: Math.max(0, profile.maxRequests - used),
    status: status, allowed: status === 'active'
  };
}

// [관리자 수동 실행 전용] 전환 경계를 모의 날짜로 읽기만 한다.
// 외부 API, 카운터 변경, 학생 명단, 메일, 트리거를 사용하지 않는다.
function diagnoseScheduledConfiguration() {
  const samples = [
    '2026-11-12T23:59:59.999+09:00', '2026-11-13T00:00:00+09:00',
    '2026-12-31T23:59:59.999+09:00', '2027-01-01T00:00:00+09:00',
    '2027-01-31T23:59:59.999+09:00', '2027-02-01T00:00:00+09:00',
    '2027-02-28T23:59:59.999+09:00', '2027-03-01T00:00:00+09:00',
    '2027-12-31T23:59:59.999+09:00', '2028-01-01T00:00:00+09:00',
    '2028-02-29T23:59:59.999+09:00', '2028-03-01T00:00:00+09:00'
  ];
  const result = {
    sourceVersion: 'api-gemini-default-2026-11-14-v27',
    switchAt: OPENAI_PERIOD_END_EXCLUSIVE, timeZone: QUOTA_TIME_ZONE,
    transitions: samples.map(function (at) {
      return { at: at, period: safePeriodDiagnostic(undefined, new Date(at)) };
    }),
    externalApiCalled: false, countersChanged: false,
    studentRosterUpdated: false, emailSent: false
  };
  Logger.log(JSON.stringify(result));
  return result;
}

// fetch 직전에 기간·일일 한도를 같은 잠금 안에서 확인하고 함께 예약한다.
// 실제 API 시도(재시도·연결시험 포함) 한 건을 예약한다. 과거 누적 속성은 수정하지 않는다.
// 재시도 중 월 경계를 넘으면 기존 기간을 종료하고 중단한다. 새 월 한도로 이전 모델을 호출하지 않는다.
function checkAndIncrementOpenAIQuota(selectedProfile) {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const now = new Date();
    const period = getOpenAIPeriodStatus(now, selectedProfile);
    if (period.status === 'not_started') throw gradingError('PERIOD_NOT_STARTED');
    if (period.status === 'expired') throw gradingError('PERIOD_EXPIRED');
    if (period.status === 'quota_reached') throw gradingError('PERIOD_QUOTA_REACHED');
    validateQuotaMaximum(MAX_DAILY_REQUESTS);
    const dailyKey = 'reqCount_' + Utilities.formatDate(now, QUOTA_TIME_ZONE, 'yyyy-MM-dd');
    const dailyCount = readQuotaCounter(props, dailyKey);
    if (dailyCount >= MAX_DAILY_REQUESTS) throw gradingError('DAILY_QUOTA_REACHED');
    const updates = {};
    updates[period.counterKey] = String(period.used + 1);
    updates[dailyKey] = String(dailyCount + 1);
    props.setProperties(updates, false);
  } finally {
    lock.releaseLock();
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// 텍스트 요약에서는 제외하고 별도로 이미지 파트로 첨부할 필드명들
// (imageData=1~9번 메인 이미지, imageData2=08번의 두 번째 AI 결과, slideImage*=10번 슬라이드,
//  refImage*=11·12번 스크린샷, cmpImage*=05번 비교 이미지)
const IMAGE_FIELD_KEYS = ['imageData', 'imageData2', 'slideImage1', 'slideImage2', 'slideImage3', 'slideImage4', 'slideImage5', 'refImageStart', 'refImageMiddle', 'refImageFinal', 'refImageMcp', 'cmpImageBefore', 'cmpImageAfter', 'cmpImageFinal'];
// 안전장치: 이미지 1장당 base64 용량 상한(약 1.2MB 원본 기준). 이보다 크면 손상되었거나 비정상 데이터로 보고 건너뛴다.
const MAX_IMAGE_BASE64_CHARS = 1600000;
// 기본미션 01~09번은 대표 이미지 1장씩 검토하되, 05번 비교 이미지는 최대 3장, 08번은 최대 2장이다.
// 05번을 먼저 선택하며 전체 이미지 수는 10장을 넘지 않는다.
// 10번(발표자료 슬라이드)은 건축 사진 관련성 판단 대상이 아니므로 이미지 채점에서 제외한다.
// (학생이 더 많이 올려도, 초과분은 이미지 없이 텍스트 기준으로만 채점되며 감점 사유가 되지 않는다.)
const MAX_IMAGES_PER_REQUEST = 10;
// 미션별로 첨부 이미지를 몇 장까지 보낼지. 지정하지 않은 미션은 1장.
const IMAGES_PER_MISSION = { '05': 3, '08': 2 };

function hasAnyImage(f) {
  return !!(f && IMAGE_FIELD_KEYS.some(function (k) { return f[k]; }));
}

function buildSummary(payload) {
  const missions = payload.missions || [];
  const core = missions.filter(function (m) { return m.id !== '11' && m.id !== '12'; });
  const completedCount = core.filter(function (m) { return m.completed; }).length;
  const imageMissionCount = missions.filter(function (m) { return m.id !== '10' && hasAnyImage(m.fields); }).length;

  const lines = [];
  // 이름·학번의 별도 필드는 AI 본문에 포함하지 않는다. 로스터 식별은 기존 payload.student를 사용한다.
  // 학생이 자유 텍스트에 직접 적은 개인정보까지 제거하는 익명화 기능은 아니다.
  lines.push('기본미션(01~10) 완료 개수: ' + completedCount + ' / ' + core.length);
  lines.push('이미지가 기록된 미션 수(10번 제외): ' + imageMissionCount + ' (실제로 전송되는 이미지는 최대 ' + MAX_IMAGES_PER_REQUEST + '장. 제공된 [미션 NN 첨부 이미지] 라벨만 판단 근거로 사용할 것. 10번은 텍스트로만 판단할 것. ' +
    '05번은 원본·AI 대안·최종 수정안 비교 이미지를 최대 3장 우선 전송하고, 08번은 서로 다른 AI 결과 두 장을 A/B로 전송할 수 있다. 누락된 비교 이미지는 추측하지 말고 대조할 자료가 부족하다고 명시할 것)');
  lines.push('교수 검토자 이름과 교수 메모는 이 AI 요약에서 제외했다. 아래 AI 도구·근거 출처·대조 기록은 학습자의 자기 기록이며 제3자가 사실 확인한 증거로 단정하지 말 것.');
  lines.push('');
  missions.forEach(function (m) {
    lines.push('[미션 ' + m.id + '] ' + m.title + ' - ' + (m.completed ? '완료' : '미완료'));
    const f = m.fields || {};
    let hasField = false;
    Object.keys(f).forEach(function (k) {
      if (k === 'completed' || k === 'compareHistory' || k === 'reviewerName' || k === 'reviewerNote' || IMAGE_FIELD_KEYS.indexOf(k) !== -1) return;
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
      const fieldLabels = {
        evidenceSource: '학생이 적은 근거 출처(실제 자료 대조 필요)',
        evidenceCheck: '학생의 근거 대조·불확실성 기록',
        aiTool: '학생이 밝힌 AI 도구',
        aiModel: '학생이 밝힌 AI 모델',
        aiUsedAt: '학생이 밝힌 AI 사용일'
      };
      lines.push('  - ' + (fieldLabels[k] || k) + ': ' + v);
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
// 05번 원본·AI 대안·최종 수정안(최대 3장)을 먼저 선택한다. 08번은 2장, 나머지는 1장이다.
// 10번 슬라이드는 제외하고, 전체 개수는 MAX_IMAGES_PER_REQUEST로 제한한다.
function collectMissionImages(payload) {
  const missions = payload.missions || [];
  const images = [];
  const ordered = missions.slice().filter(function (m) { return m.id !== '10'; }).sort(function (a, b) {
    const aPriority = a.id === '05' ? 0 : ((a.id === '11' || a.id === '12') ? 2 : 1);
    const bPriority = b.id === '05' ? 0 : ((b.id === '11' || b.id === '12') ? 2 : 1);
    return aPriority - bPriority;
  });
  ordered.forEach(function (m) {
    const f = m.fields || {};
    const limit = IMAGES_PER_MISSION[m.id] || 1;
    const fieldKeys = m.id === '05'
      ? ['cmpImageBefore', 'cmpImageAfter', 'cmpImageFinal', 'imageData']
      : IMAGE_FIELD_KEYS;
    const comparisonLabels = {
      cmpImageBefore: ' 원본(수정 전)',
      cmpImageAfter: ' AI 대안',
      cmpImageFinal: ' 최종 수정안',
      imageData: ' 참고 이미지'
    };
    let taken = 0;
    for (let i = 0; i < fieldKeys.length && taken < limit; i++) {
      if (images.length >= MAX_IMAGES_PER_REQUEST) return;
      const dataUrl = f[fieldKeys[i]];
      if (!dataUrl || typeof dataUrl !== 'string') continue;
      const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!match) continue;
      const mimeType = match[1];
      const base64 = match[2];
      if (base64.length > MAX_IMAGE_BASE64_CHARS) continue; // 비정상적으로 큰 데이터는 건너뛴다
      // 같은 미션에서 두 장 이상 보낼 때는 A/B 라벨로 구분해 AI가 어느 쪽인지 알게 한다.
      const label = m.id === '05' ? comparisonLabels[fieldKeys[i]] : (limit > 1 ? ' ' + String.fromCharCode(65 + taken) : '');
      images.push({ missionId: m.id, label: label, mimeType: mimeType, base64: base64 });
      taken++;
    }
  });
  return images;
}

function imageLabel(img) {
  return '[미션 ' + img.missionId + ' 첨부 이미지' + (img.label || '') + ']';
}

// Gemini 멀티모달 파트(라벨 텍스트 + inlineData) 형식으로 변환한다.
function buildImagePartsGemini(images) {
  const parts = [];
  images.forEach(function (img) {
    parts.push({ text: imageLabel(img) });
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
  });
  return parts;
}

// OpenAI Responses API의 content 파트(input_text + input_image) 형식으로 변환한다.
// detail:'low'로 고정해 이미 저해상도로 압축된 이미지의 토큰 비용을 추가로 낮춘다.
function buildImagePartsOpenAI(images) {
  const parts = [];
  images.forEach(function (img) {
    parts.push({ type: 'input_text', text: imageLabel(img) });
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
    '2) 미션 01~10(기본미션)만 아래 5개 기준으로 등급을 매기고, 그것을 종합해 전체 등급(overallTier)도 하나 정해라.\n' +
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
    '   - 기본미션 10개 중 3개 이하 완료: overallTier는 "노력 필요"를 넘을 수 없다\n' +
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

// ACTIVE_PROVIDER 설정에 따라 Gemini 또는 OpenAI로 채점 요청을 분기한다.
function gradeWithAI(payload) {
  if (!Array.isArray(payload.missions)) throw gradingError('INVALID_REQUEST');
  const summary = buildSummary(payload);
  const isOpenAI = ACTIVE_PROVIDER === 'openai';
  const prompt = buildGradingPrompt(summary, isOpenAI ? 'deep' : 'fast');
  const images = collectMissionImages(payload);
  if (isOpenAI) {
    return gradeWithOpenAI(prompt, images);
  }
  return gradeWithGemini(prompt, images);
}

function gradeWithGemini(prompt, images, maxAttempts) {
  if (maxAttempts !== undefined && maxAttempts !== 1) throw gradingError('CONFIG_INVALID');
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }].concat(buildImagePartsGemini(images)) }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseJsonSchema: GRADING_JSON_SCHEMA,
      maxOutputTokens: 8000
    }
  };
  // 기존 웹 채점요청당 일일 카운터는 doPost에서 센다. 관리자 검사는 호출 전에 직접 센다.
  // 일시적 혼잡만 기존처럼 재시도하며, 관리자 검사는 maxAttempts=1로 실제 시도 1회만 사용한다.
  const attempts = maxAttempts === 1 ? 1 : 4;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return validateGeminiGradingReport(parseGradingResponse(geminiOutputText(requestGeminiOnce(body))));
    } catch (err) {
      if (classifyGradingError(err) !== 'UPSTREAM_BUSY' || attempt === attempts) throw err;
      Utilities.sleep(1500 * Math.pow(2, attempt - 1));
    }
  }
  throw gradingError('INTERNAL_ERROR');
}

// 키는 스크립트 속성에서 읽어 헤더로만 전달한다. URL·응답·로그에 키를 넣지 않는다.
// 일일 한도는 기존 doPost 또는 관리자 함수에서 호출당 한 번 검사한다.
function requestGeminiOnce(body) {
  const apiKey = getApiKey('GEMINI_API_KEY').trim();
  if (!apiKey) throw gradingError('CONFIG_MISSING');
  if (!body || !Array.isArray(body.contents) || !body.generationConfig ||
      body.generationConfig.responseMimeType !== 'application/json' || !body.generationConfig.responseJsonSchema) {
    throw gradingError('CONFIG_INVALID');
  }
  let response;
  try {
    response = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-goog-api-key': apiKey },
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
  } catch (fetchError) {
    throw gradingError('UPSTREAM_ERROR', undefined, 'gemini');
  }
  const status = response.getResponseCode();
  const raw = response.getContentText();
  if (status !== 200) throw upstreamError('gemini', status, raw);
  return parseApiEnvelope(raw);
}

function geminiOutputText(data) {
  const candidate = Array.isArray(data.candidates) && data.candidates[0];
  if (!candidate || candidate.finishReason !== 'STOP' || !candidate.content || !Array.isArray(candidate.content.parts)) {
    throw gradingError('INVALID_AI_RESPONSE', 200, 'gemini');
  }
  const raw = candidate.content.parts.filter(function (part) {
    return part && part.thought !== true && typeof part.text === 'string';
  }).map(function (part) { return part.text; }).join('').trim();
  if (!raw || typeof raw !== 'string') throw gradingError('INVALID_AI_RESPONSE');
  return raw;
}

// 기존 공통 응답 파서를 재사용한 뒤 학습자 화면에 필요한 목록·등급·문자열 형식을 확인한다.
function validateGeminiGradingReport(report) {
  const tiers = ['매우 잘함', '잘함', '보통', '노력 필요'];
  const isText = function (value) { return typeof value === 'string'; };
  const validTier = function (value) { return tiers.indexOf(value) !== -1; };
  if (!validTier(report.overallTier) || !isText(report.selfEvalCheck.note) || report.criteria.length !== CRITERIA.length ||
      !CRITERIA.every(function (criterion) {
        const matches = report.criteria.filter(function (item) { return item && item.name === criterion.name; });
        return matches.length === 1 && validTier(matches[0].tier) && isText(matches[0].comment);
      }) || report.missionNotes.length !== 10 || !Array.from({ length: 10 }, function (_, i) {
        return ('0' + (i + 1)).slice(-2);
      }).every(function (id) {
        const matches = report.missionNotes.filter(function (item) { return item && item.id === id; });
        return matches.length === 1 && validTier(matches[0].tier) && isText(matches[0].note);
      }) || report.bonusMissions.length !== 2 || !['11', '12'].every(function (id) {
        const matches = report.bonusMissions.filter(function (item) { return item && item.id === id; });
        return matches.length === 1 && typeof matches[0].completed === 'boolean' &&
          isText(matches[0].label) && isText(matches[0].comment);
      })) {
    throw gradingError('INVALID_AI_RESPONSE', 200, 'gemini');
  }
  return report;
}

// [관리자 수동 실행 전용] 실제 Gemini 요청 1회. 일일 한도를 차감한다.
// 학생 명단·메일·트리거를 거치지 않으며 doPost action으로 노출하지 않는다.
function testGeminiConnection() {
  const requestId = createRequestId();
  let externalApiCalls = 0;
  let result;
  try {
    if (!getApiKey('GEMINI_API_KEY').trim()) throw gradingError('CONFIG_MISSING');
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Return only {"ok":true}. Administrator connection test with synthetic data only.' }] }],
      generationConfig: {
        temperature: 0.1, maxOutputTokens: 1024, responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
      }
    };
    checkAndIncrementDailyQuota();
    externalApiCalls = 1;
    let reply;
    try { reply = JSON.parse(geminiOutputText(requestGeminiOnce(body))); }
    catch (err) { if (err && err.gradingCode) throw err; throw gradingError('INVALID_AI_RESPONSE'); }
    if (!reply || reply.ok !== true || Object.keys(reply).length !== 1) throw gradingError('INVALID_AI_RESPONSE');
    result = { ok: true, model: GEMINI_MODEL, provider: 'gemini', requestId: requestId, upstreamStatus: 200,
      externalApiCalls: externalApiCalls, studentRosterUpdated: false, emailSent: false };
  } catch (err) {
    result = geminiDiagnosticFailure(err, requestId, externalApiCalls);
  }
  Logger.log(JSON.stringify(result));
  return result;
}

// [관리자 수동 실행 전용] 실제 평가 프롬프트·공개 건축 예제 이미지·전체 JSON 형식 검사.
// 공개 이미지 읽기 1회와 Gemini 실제 시도 1회만 사용한다. 학생 자료·명단·메일·트리거 변경 없음.
// 이미지가 없거나 형식·용량이 다르면 실패하며 텍스트 전용 검사로 자동 전환하지 않는다.
// 일일 한도 1회 차감, 자동 재시도 없음. 응답 형식 검증은 건축 해석의 정확성 보증이 아니다.
function testGeminiGrading() {
  const requestId = createRequestId();
  let externalApiCalls = 0;
  let publicImageRequests = 0;
  let stage = 'configuration';
  let result;
  try {
    if (!getApiKey('GEMINI_API_KEY').trim()) throw gradingError('CONFIG_MISSING');
    stage = 'public_image_fetch';
    publicImageRequests = 1;
    const imageData = fetchGeminiTestImage();
    const fields = {
      projectNote: 'DEMO DATA: 관리자 연결점검용 가상기록이며 실제 학생·성적이 아닙니다. 사이트에 공개된 건축 예제 이미지 한 장만 사용합니다.',
      step1: '공개 예제에서 회색 콘크리트 질감의 외벽, 어긋난 상자형 매스, 중앙 유리 아트리움, 큰 창, 식재 테라스, 전면 보행공간과 계단을 관찰했습니다. 실제 용도·구조 안전성은 이미지 한 장만으로 확정하지 않습니다.',
      step2: '가상 프롬프트: 도심 가로에 면한 중층 건물, 회색 콘크리트 질감과 유리, 어긋난 매스와 식재 테라스, 전면 보행공간을 유지한 사선 시점의 주간 건축 시각화. 교육시설이라는 용도 해석은 추정입니다.',
      step3: '가상 실험 계획은 매스·창호·카메라를 고정하고 외벽 재료 하나만 바꾸는 세 대안을 비교하는 것입니다. 실제 AI 변형 생성은 수행하지 않았으며 첨부는 공개 원본 한 장뿐입니다.',
      step4: '원본의 매스와 중앙 유리 공간은 확인했으나 변형 결과가 없어 요청조건 유지 여부는 대조하지 못했습니다. 난간 높이·계단 치수·피난·접근성·구조 성능은 도면과 전문 검토가 필요합니다.',
      evidenceSource: 'https://zeroarchitect.kr/images/01/example-1.jpg — 사이트 공개 건축 예제. 실제 학생 또는 비공개 설계자료가 아닙니다.',
      evidenceCheck: '보이는 건축 요소와 용도·성능 추정을 분리했습니다. 실제 재료 성능, 층고, 법규 충족과 변형 실험 수행 여부는 확인하지 못했습니다.',
      decisionType: '수정', decision: '용도·성능을 단정한 표현을 수정하고 관찰과 추정을 분리합니다. 원본 특징을 정리하는 용도로만 제한적으로 활용하고 실제 변형 실험과 상세 검토는 미실시로 남깁니다.',
      completed: false,
      imageData: imageData
    };
    const payload = {
      student: { name: '연결점검용 가상기록', studentId: 'SYSTEM-CHECK-20261114' },
      missions: Array.from({ length: 12 }, function (_, i) {
        const id = ('0' + (i + 1)).slice(-2);
        return { id: id, title: i === 0 ? '건축 이미지를 프롬프트로 역설계하기' : '미작성 미션 ' + id,
          completed: false, fields: i === 0 ? fields : {} };
      }),
      selfEval: { overall: '합성 연결점검 자료이며 실제 학생 능력이나 성적을 평가할 근거가 없습니다.' }
    };
    const images = collectMissionImages(payload);
    if (images.length !== 1) throw gradingError('INVALID_REQUEST');
    const prompt = buildGradingPrompt(buildSummary(payload), 'fast');
    stage = 'gemini_grading';
    checkAndIncrementDailyQuota();
    externalApiCalls = 1;
    const report = gradeWithGemini(prompt, images, 1);
    result = { ok: true, model: GEMINI_MODEL, provider: 'gemini', requestId: requestId, upstreamStatus: 200,
      externalApiCalls: externalApiCalls, schemaValidated: true, criteriaCount: report.criteria.length,
      missionNotesCount: report.missionNotes.length, bonusMissionsCount: report.bonusMissions.length,
      publicImageRequests: publicImageRequests, imagesSent: images.length, imageKind: 'public_architecture_example',
      visionPathValidated: true, interpretationAccuracyValidated: false,
      studentRosterUpdated: false, emailSent: false };
  } catch (err) {
    result = geminiDiagnosticFailure(err, requestId, externalApiCalls);
    result.stage = stage;
    result.publicImageRequests = publicImageRequests;
  }
  Logger.log(JSON.stringify(result));
  return result;
}

// 관리자 진단만 사용하는 고정 공개 예제. 임의 URL이나 학생 업로드를 받지 않는다.
function fetchGeminiTestImage() {
  let response;
  try {
    response = UrlFetchApp.fetch('https://zeroarchitect.kr/images/01/example-1.jpg', { muteHttpExceptions: true });
  } catch (err) {
    throw gradingError('INVALID_REQUEST');
  }
  const status = response.getResponseCode();
  if (status !== 200) throw gradingError('INVALID_REQUEST', status);
  const blob = response.getBlob();
  const mimeType = String(blob.getContentType() || '').split(';')[0].trim().toLowerCase();
  if (mimeType !== 'image/jpeg') throw gradingError('INVALID_REQUEST', status);
  const bytes = blob.getBytes();
  if (!bytes || bytes.length < 4 || bytes.length > 1200000 ||
      (bytes[0] & 255) !== 255 || (bytes[1] & 255) !== 216 || (bytes[2] & 255) !== 255) {
    throw gradingError('INVALID_REQUEST', status);
  }
  const base64 = Utilities.base64Encode(bytes);
  if (!base64 || base64.length > MAX_IMAGE_BASE64_CHARS) throw gradingError('INVALID_REQUEST', status);
  return 'data:image/jpeg;base64,' + base64;
}

function geminiDiagnosticFailure(err, requestId, externalApiCalls) {
  return { ok: false, model: GEMINI_MODEL, provider: 'gemini', requestId: requestId,
    code: classifyGradingError(err), error: safeErrorMessage(err),
    upstreamStatus: Number.isFinite(err && err.upstreamStatus) ? err.upstreamStatus : null,
    upstreamCode: safeUpstreamCode(err), externalApiCalls: externalApiCalls,
    studentRosterUpdated: false, emailSent: false };
}

// OpenAI Responses API 요청 한 번. API 키·요청·상류 오류 원문은 로그에 남기지 않는다.
// 재시도는 호출자가 제어한다. 이 함수는 한 번의 fetch만 수행하고 각 시도에 한도를 적용한다.
function requestOpenAIOnce(body, selectedProfile) {
  const profile = selectedProfile || resolveOpenAIProfile(new Date());
  if (!body || body.model !== profile.model || !body.reasoning || body.reasoning.effort !== profile.reasoningEffort) {
    throw gradingError('CONFIG_INVALID');
  }
  const apiKey = getApiKey('OPENAI_API_KEY').trim();
  if (!apiKey) throw gradingError('CONFIG_MISSING');
  const payload = JSON.stringify(body);
  checkAndIncrementOpenAIQuota(profile);
  let response;
  try {
    response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + apiKey },
      payload: payload, muteHttpExceptions: true
    });
  } catch (fetchError) {
    throw gradingError('UPSTREAM_ERROR', undefined, 'openai');
  }
  const status = response.getResponseCode();
  const raw = response.getContentText();
  if (status !== 200) throw upstreamError('openai', status, raw);
  const data = parseApiEnvelope(raw);
  if (data.status !== 'completed') throw gradingError('INVALID_AI_RESPONSE', status, 'openai');
  return data;
}

function openAIOutputText(data) {
  const messageItem = Array.isArray(data.output) && data.output.filter(function (o) { return o && o.type === 'message'; })[0];
  const textItem = messageItem && Array.isArray(messageItem.content) &&
    messageItem.content.filter(function (c) { return c && c.type === 'output_text'; })[0];
  const raw = textItem && textItem.text;
  if (!raw || typeof raw !== 'string') throw gradingError('INVALID_AI_RESPONSE');
  return raw;
}

// 현재 선택한 모델로 학생 기록과 이미지에 대한 구조화된 참고 피드백을 요청한다.
function gradeWithOpenAI(prompt, images) {
  const profile = resolveOpenAIProfile(new Date());
  const imageParts = buildImagePartsOpenAI(images);
  const content = [{ type: 'input_text', text: prompt }].concat(imageParts);
  const body = {
    model: profile.model,
    store: false,
    input: [{ role: 'user', content: content }],
    reasoning: { effort: profile.reasoningEffort },
    text: { format: { type: 'json_schema', name: 'grading_report', strict: true, schema: GRADING_JSON_SCHEMA } },
    max_output_tokens: 8000
  };

  // 일시적 혼잡만 재시도한다. 결제·인증·모델·기간·횟수 오류는 반복하지 않는다.
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return parseGradingResponse(openAIOutputText(requestOpenAIOnce(body, profile)));
    } catch (err) {
      if (classifyGradingError(err) !== 'UPSTREAM_BUSY' || attempt === MAX_ATTEMPTS) throw err;
      Utilities.sleep(1500 * Math.pow(2, attempt - 1));
    }
  }
  throw gradingError('INTERNAL_ERROR');
}

// [관리자 수동 실행 전용·유료 API 호출 1회] Apps Script 편집기의 함수 목록에서 실행한다.
// 날짜·일일·기간 상한을 지키며 실제 시도 1회를 차감한다. 학생 명단·메일·트리거는 수정하지 않는다.
// doPost의 action으로 노출하지 않는다. 연결시험 성공은 실제 학생 평가 성공까지 보증하지 않는다.
function testOpenAIConnection() {
  const requestId = createRequestId();
  let result;
  let profile;
  try {
    profile = resolveOpenAIProfile(new Date());
    const body = {
      model: profile.model, store: false,
      input: [{ role: 'user', content: [{ type: 'input_text',
        text: 'Return a JSON object with ok set to true. This is an administrator connection test using synthetic data only.' }] }],
      reasoning: { effort: profile.reasoningEffort },
      text: { format: { type: 'json_schema', name: 'connection_check', strict: true,
        schema: { type: 'object', properties: { ok: { type: 'boolean', enum: [true] } },
          required: ['ok'], additionalProperties: false } } },
      max_output_tokens: 1024
    };
    const data = requestOpenAIOnce(body, profile); // 단 한 번만 호출한다. 자동 재시도 없음.
    let reply;
    try { reply = JSON.parse(openAIOutputText(data)); } catch (e) { throw gradingError('INVALID_AI_RESPONSE'); }
    if (!reply || reply.ok !== true || Object.keys(reply).length !== 1) throw gradingError('INVALID_AI_RESPONSE');
    result = { ok: true, model: profile.model, reasoningEffort: profile.reasoningEffort,
      requestId: requestId, upstreamStatus: 200,
      period: safePeriodDiagnostic(profile), externalApiCalls: 1, studentRosterUpdated: false, emailSent: false };
  } catch (err) {
    result = { ok: false, model: profile ? profile.model : null,
      reasoningEffort: profile ? profile.reasoningEffort : null, requestId: requestId,
      code: classifyGradingError(err), error: safeErrorMessage(err),
      upstreamStatus: Number.isFinite(err && err.upstreamStatus) ? err.upstreamStatus : null,
      upstreamCode: safeUpstreamCode(err),
      period: safePeriodDiagnostic(profile), studentRosterUpdated: false, emailSent: false };
  }
  Logger.log(JSON.stringify(result));
  return result;
}

