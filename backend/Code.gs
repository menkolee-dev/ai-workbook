/**
 * Architecture AX Expert - AI 채점 백엔드 (Google Apps Script)
 * 배포 방법: 저장소 루트의 DEPLOY.md 참고
 */

// 1) https://aistudio.google.com/apikey 에서 무료로 발급받은 Gemini API 키를 아래에 붙여넣으세요.
const GEMINI_API_KEY = '여기에_발급받은_Gemini_API_키를_붙여넣으세요';
const GEMINI_MODEL = 'gemini-2.0-flash';

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
    const report = gradeWithAI(payload);
    return jsonResponse({ ok: true, report: report });
  } catch (err) {
    return jsonResponse({ ok: false, error: String((err && err.message) || err) });
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

  const prompt =
    '너는 건축·공간디자인 AI 활용 수업의 채점 조교다. 아래 학생의 12개 미션 실습 기록을 읽고, ' +
    '다음 5개 기준으로 각각 0~20점을 매기고 총점(100점 만점)과 등급(A/B/C/D/F), 총평, 각 기준별 코멘트를 작성해라.\n\n' +
    '채점 기준:\n' + criteriaList + '\n\n' +
    '반드시 아래 JSON 형식으로만 응답하고 다른 텍스트는 절대 포함하지 마라:\n' +
    '{"totalScore":숫자,"grade":"A/B/C/D/F 중 하나","overallComment":"총평 2~3문장","criteria":[{"name":"기준명","score":숫자,"comment":"코멘트 1~2문장"}]}\n' +
    '(criteria 배열은 반드시 위 5개 기준 각각에 대해 하나씩, 총 5개 항목이어야 한다)\n\n' +
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
