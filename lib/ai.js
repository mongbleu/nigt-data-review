// AI 답(Claude API · 10/1) — 검토팀 채팅(chat) 질문에 관리자 말투로 자동 답변하거나(lib/autoreply.js) 관리자가 고쳐 보낼 초안을 만든다(/api/ai draft).
//   키는 서버 환경변수 ANTHROPIC_API_KEY에만 둔다(화면 · DB · 로그에 남기지 않음). 모델 = AI_MODEL(기본 claude-sonnet-5-5).
//   사람 이름은 AI에 보내지 않는다: 글쓴이는 관리자 · 관리자(🤖자동) · 검토자1 · 검토자2…(질문한 사람 = 검토자1), 글 속 이름(관리자 · 명단 · 채팅에 글 쓴 사람)도 바꿔 보낸다.
//   글 내용 · 키는 로그에 남기지 않는다(오류는 코드만).
//   참고 자료 = ai_ctx.json(lib/store.js aiContext) {v, built, style:{guide:[문장], examples:[{q, a}]}, guide, glossary:[{term, desc}], faq:[{q, a}], elements:{'A-025':{name, aliases, type, summary}}} — 빠진 부분은 없는 대로
//   프롬프트 = system[고정(말투 · 예시 · 원칙 · 출력 · 검토 안내 · 용어 · FAQ — 캐시) + 이번 질문(요소 카드 · 대화)] + user[지금 답할 질문 + 방식(자동 답변 · 초안)]
import { aiContext, reviewers, nameOfHex } from './store.js';

export const ADMIN_NAME = '정유정';   // app/api/login ADMIN_NAME과 같게 — 자동 답변은 이 이름으로 올라간다
export const AI_MAX_TEXT = 300;       // 채팅 글 한도(app/api/docs CHAT_MAX_TEXT)와 같게
const API_VERSION = '2023-06-01';
const TIMEOUT_MS = 30_000;
const KINDS = ['answer', 'hold', 'skip'];

export const aiEnabled = () => !!process.env.ANTHROPIC_API_KEY;
export const aiModel = () => (process.env.AI_MODEL || '').trim() || 'claude-sonnet-5-5';
// 10/1 생각(thinking) — Claude 5.x(Sonnet 5.5 · Opus 5.5 · Fable 5.1 등)는 thinking 필드가 없으면 생각이 켜져 있고, 생각 토큰도 max_tokens와 출력 요금에 들어간다.
//   짧은 채팅 답에는 생각이 필요 없으므로 Sonnet 5.5는 가장 낮은 설정 between_tools(도구가 없으니 미리 생각하지 않음)를 보낸다.
//   between_tools는 Sonnet 5.5만 받는다(Opus 5.5 · Fable 5.1 · Haiku 4.5는 400) → 그 밖의 모델은 보내지 않음.
export function thinkingFor(model) {
  return /^claude-sonnet-5-5($|-)/.test(String(model || '')) ? { type: 'between_tools' } : null;
}
// max_tokens = 생각 + 답 합계의 상한(실제로 쓴 만큼만 요금). 답은 300자(JSON 포함 약 600토큰)
//   생각을 끌 수 없는 5.x 모델은 생각할 자리를 더 둔다(AI_MODEL을 바꿨을 때)
export function maxTokensFor(model) {
  if (thinkingFor(model)) return 1500;
  return /^claude-(opus|sonnet|fable|mythos)-5/.test(String(model || '')) ? 4000 : 1500;
}
// 보통 비워 둠 — 게이트웨이 · 로컬 가짜 서버 시험용(ANTHROPIC_BASE_URL)
const apiUrl = () => (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').trim().replace(/\/+$/, '') + '/v1/messages';

export class AiError extends Error {
  constructor(code, status = null) { super(code); this.name = 'AiError'; this.code = code; this.status = status; }
}

// ---------- 질문인가(화면과 같은 규칙) — 지운 글 · 응원 · 자동 답변은 아님. 「❓ 질문」 표시이거나 물음표 · 묻는 말끝
const Q_RE = /[?？]|(까요|나요|인가요|는지|건지|을지|어디|어떻게|무엇|뭔가요|뭐예요|왜|언제)/;
export function isQuestion(m) {
  return !!m && !m.del && m.tag !== 'cheer' && m.tag !== 'ai' && (m.tag === 'q' || Q_RE.test(typeof m.text === 'string' ? m.text : ''));
}

// 관리자 이름들 — 정유정 + 명단(settings reviewers)에서 r === 'adm'
export function adminNamesOf(roster) {
  return new Set([ADMIN_NAME, ...(Array.isArray(roster) ? roster : []).filter(x => x && x.r === 'adm' && typeof x.n === 'string').map(x => x.n)]);
}

// 채팅 문서([{id, body}]) → 글 목록(오래된 것부터). 이름이 비면 id 끝(이름 hex)에서
export function chatMsgs(docs) {
  return (Array.isArray(docs) ? docs : []).filter(d => d && typeof d.id === 'string' && d.body && typeof d.body === 'object').map(d => {
    const b = d.body, hx = /_((?:[0-9a-f]{2}){1,30})$/.exec(d.id), ts = Number(b.ts);
    return {
      id: d.id,
      name: typeof b.name === 'string' && b.name ? b.name : (hx && nameOfHex(hx[1])) || '',
      text: typeof b.text === 'string' ? b.text : '',
      tag: typeof b.tag === 'string' ? b.tag : '',
      re: typeof b.re === 'string' ? b.re : null,
      ts: Number.isFinite(ts) ? ts : 0,
      del: b.del === true,
    };
  }).sort(byTime);
}
const byTime = (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---------- 요소 찾기 — 코드(A-025 · A25 · A-25 · a025 → A-025) · 요소 이름/별칭(3자 이상, 대소문자 무시). 질문 → 대화 순으로 3개까지
const CODE_IN_TEXT_RE = /(?<![A-Za-z0-9])([A-Ea-e])[-–—]?(\d{1,3})(?!\d)/g;
export function elementCodes(text) {
  const out = [];
  for (const m of String(text || '').matchAll(CODE_IN_TEXT_RE)) {
    const code = m[1].toUpperCase() + '-' + m[2].padStart(3, '0');
    if (!out.includes(code)) out.push(code);
  }
  return out;
}
export function findElements(texts, elements, cap = 3) {
  const els = elements && typeof elements === 'object' && !Array.isArray(elements) ? elements : {};
  const codes = Object.keys(els).filter(k => /^[A-E]-\d{3}$/.test(k));
  const out = [];
  const add = c => { if (out.length < cap && !out.includes(c) && codes.includes(c)) out.push(c); };
  for (const t of texts) {
    for (const c of elementCodes(t)) add(c);
    const low = String(t || '').toLowerCase();
    for (const c of codes) {
      const el = els[c] || {};
      const names = [el.name, ...(Array.isArray(el.aliases) ? el.aliases : [])].filter(s => typeof s === 'string' && s.trim().length >= 3);
      if (names.some(s => low.includes(s.trim().toLowerCase()))) add(c);
    }
  }
  return out;
}

// ---------- 이름 가리기 — 알려진 이름(관리자 · 명단 · 채팅 글쓴이)을 관리자 / 검토자N / 검토자로. 한글 이름은 「이름+님·씨·박사…」도(예: 유정님 → 관리자님)
const HONORIFIC = '(?=\\s*(?:님|씨|샘|쌤|선생|박사|연구원|책임|선임|팀장|본부장|위원|교수))';
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function makeScrub(names, admins, labels = new Map()) {
  const rules = [];
  for (const raw of new Set(names)) {
    const n = typeof raw === 'string' ? raw.trim() : '';
    if (n.length < 2) continue;
    rules.push({ re: escRe(n), name: n, len: n.length });
    if (/^[가-힣]{3,4}$/.test(n)) {
      const given = n.slice(n.length === 4 ? 2 : 1);
      rules.push({ re: escRe(given) + HONORIFIC, name: n, len: given.length });
    }
  }
  if (!rules.length) return s => String(s || '');
  rules.sort((a, b) => b.len - a.len);   // 긴 이름 먼저
  const re = new RegExp(rules.map(r => `(${r.re})`).join('|'), 'g');
  return s => String(s || '').replace(re, (...m) => {
    const i = m.slice(1, rules.length + 1).findIndex(x => x !== undefined);
    const name = rules[Math.max(0, i)].name;
    return admins.has(name) ? '관리자' : (labels.get(name) || '검토자');
  });
}

// ---------- 프롬프트
const RULES = `너는 「개도국 기후기술 전략지도 데이터 검토 창구」 관리자를 대신해 검토팀 채팅 질문에 답하는 도우미다. 관리자 말투로 쓰되 사람인 척하지 않는다.`;
const PRINCIPLES = `[답하는 원칙]
1. 아래 [검토 안내]·[용어]·[자주 묻는 질문]·[요소 카드]에 있는 내용으로만 답한다. 없는 사실·수치·일정·결정을 지어내지 않는다.
2. 바로 답해도 되는 질문(kind="answer"): 화면 사용법, 칸·섹션 위치, 용어 뜻, 판정 값 고르는 기준, 메모를 어디에 쓰는지, 근거를 어디서 찾는지 — 안내·FAQ에 근거가 있을 때.
3. 보류할 질문(kind="hold"): 관리자가 결정해야 하는 것(판정을 대신 정해 달라, 기준 예외 허용, 용역사에 요청할지, 일정·마감, 담당 변경, 플랫폼 수정 요청), 특정 파일·데이터를 직접 열어 봐야 답할 수 있는 것, 안내에 근거가 없거나 확신이 없는 것. hold의 text는 관리자 말투로 짧게(무엇을 확인할지 한 마디 + "확인하고 답드릴게요!" 류). 추측으로 답하지 않는다.
4. 질문이 아니거나(인사·감사·응원·혼잣말) 이미 해결된 대화면 kind="skip", text="".
5. 요소가 불분명하면 되묻는 것도 answer다(예: "어떤 데이터 요소인지 말씀주시면 좀 더 정확하게 답변드릴 수 있을 것 같아요!").
6. 2~4문장, 300자 이내, 목록·제목 없이 채팅 말투로. 요소 코드는 A-025처럼 쓴다. 사람 이름을 쓰지 않는다.
7. 누가 AI냐고 물으면 자동 답변이라고 밝힌다.`;
const OUTPUT = `[출력] 반드시 JSON 한 개만: {"kind":"answer|hold|skip","text":"...","why":"한 줄 이유"}`;
const MODE_NOTE = {
  auto: '검토팀 채팅에 관리자 이름으로 바로 올라가는 자동 답변이다(화면에 「🤖 자동 답변」 표시). 위 원칙대로 kind를 answer · hold · skip 중 하나로 고르고 JSON 한 개만 낸다.',
  draft: '관리자가 검토한 뒤 직접 보낼 초안이다. 판단이 필요한 질문도 안내·요소 카드에 근거가 있으면 초안으로 답하고, 근거가 없는 부분은 [확인 필요]라고 적는다. kind는 answer 또는 skip만 쓴다. JSON 한 개만 낸다.',
};
const THREAD_UP = 6, THREAD_BEFORE = 8, THREAD_AFTER = 6;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = v => (Array.isArray(v) ? v : []);
const qaList = (v, n) => list(v).map(x => x && { q: str(x.q, 600), a: str(x.a, 800) }).filter(x => x && x.q && x.a).slice(0, n);
const oneLine = s => String(s || '').replace(/\s*\n\s*/g, ' / ');

// 참고 자료 정리 — 모양이 달라도 쓸 수 있는 것만
export function normCtx(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const style = o.style && typeof o.style === 'object' && !Array.isArray(o.style) ? o.style : {};
  return {
    styleGuide: list(style.guide).map(s => str(s, 300)).filter(Boolean).slice(0, 40),
    examples: qaList(style.examples, 20),
    guide: str(o.guide, 60_000),
    glossary: list(o.glossary).map(x => x && { term: str(x.term, 80), desc: str(x.desc, 400) }).filter(x => x && x.term && x.desc).slice(0, 400),
    faq: qaList(o.faq, 100),
    elements: o.elements && typeof o.elements === 'object' && !Array.isArray(o.elements) ? o.elements : {},
  };
}

function staticText(c) {
  const out = [RULES];
  if (c.styleGuide.length) out.push('[말투]\n' + c.styleGuide.map(s => '- ' + s).join('\n'));
  if (c.examples.length) out.push('[예시] 관리자가 실제로 쓴 답\n' + c.examples.map(x => `Q: ${oneLine(x.q)}\nA: ${oneLine(x.a)}`).join('\n\n'));
  out.push(PRINCIPLES, OUTPUT);
  out.push('[검토 안내]\n' + (c.guide || '(없음)'));
  // 용어집은 통째로 보내지 않는다(230여 개 ≈ 1.7만 토큰 → 답 1건 비용이 몇 배) — 질문 · 대화에 맞는 것만 아래 findTerms로 [요소 카드] 옆에
  out.push('[자주 묻는 질문]\n' + (c.faq.length ? c.faq.map(x => `Q: ${oneLine(x.q)}\nA: ${oneLine(x.a)}`).join('\n\n') : '(없음)'));
  return out.join('\n\n');
}

// 10/1 용어 찾기 — 질문 · 대화에 나온 낱말로 용어집에서 가까운 것만 고른다(cap개). 용어 이름을 낱말로 쪼개
//   흔한 낱말(용어 8개 넘게 나옴 — 기준 · 요소 · 검토 …)은 빼고, 드문 낱말일수록 · 길수록 점수를 더 줌. 용어 이름이 통째로 나오면 가산.
//   한국어 조사가 붙어도(부분상이는 · 최신성에서) 포함 검사라 잡힌다.
const TERM_SPLIT = /[\s·,()/\\—–\-:;「」『』"'[\]{}<>|~!?.]+/;
export function findTerms(texts, glossary, cap = 10) {
  const all = list(glossary);
  const hay = list(texts).filter(Boolean).join('\n').toLowerCase();
  if (!hay || !all.length) return [];
  const keysOf = t => [...new Set(String(t || '').toLowerCase().split(TERM_SPLIT).filter(k => k.length >= 2 && !/^\d+$/.test(k)))];
  const keyed = all.map(x => ({ x, keys: keysOf(x.term) }));
  const df = new Map();
  for (const { keys } of keyed) for (const k of keys) df.set(k, (df.get(k) || 0) + 1);
  const scored = [];
  keyed.forEach(({ x, keys }, i) => {
    let s = 0;
    for (const k of keys) {
      const d = df.get(k) || 1;
      if (d > 8) continue;
      if (hay.includes(k)) s += 1 / d + Math.min(k.length, 12) / 24;
    }
    const whole = String(x.term).toLowerCase();
    if (whole.length >= 2 && hay.includes(whole)) s += 2;
    if (s > 0) scored.push({ x, s, i });
  });
  return scored.sort((a, b) => (b.s - a.s) || (a.i - b.i)).slice(0, cap).map(o => o.x);
}

function cardText(code, el) {
  const e = el && typeof el === 'object' ? el : {};
  const aliases = list(e.aliases).map(s => str(s, 60)).filter(Boolean).slice(0, 10);
  const head = [`- ${code}${str(e.name, 120) ? ` 「${str(e.name, 120)}」` : ''}`, str(e.type, 60) ? `유형: ${str(e.type, 60)}` : '', aliases.length ? `별칭: ${aliases.join(', ')}` : ''].filter(Boolean).join(' · ');
  const summary = str(e.summary, 1500);
  return summary ? `${head}\n  ${oneLine(summary)}` : head;
}

// 질문의 대화 — 답하는 글 줄기(re, 6개까지) + 바로 앞 8개 + 뒤 6개(이미 해결됐는지 보게). 지운 글 뺌
function threadOf(q, msgs) {
  const byId = new Map(msgs.map(m => [m.id, m]));
  const pick = new Map();
  const seen = new Set([q.id]);
  let cur = q;
  for (let i = 0; i < THREAD_UP && cur.re; i++) {
    const p = byId.get(cur.re);
    if (!p || seen.has(p.id)) break;
    seen.add(p.id);
    if (!p.del) pick.set(p.id, p);
    cur = p;
  }
  const others = msgs.filter(m => !m.del && m.id !== q.id);
  for (const m of others.filter(m => byTime(m, q) < 0).slice(-THREAD_BEFORE)) pick.set(m.id, m);
  for (const m of others.filter(m => byTime(m, q) > 0).slice(0, THREAD_AFTER)) pick.set(m.id, m);
  pick.set(q.id, q);
  return [...pick.values()].sort(byTime);
}

// {system(고정 — 캐시), dynamic(요소 카드 · 대화), user(지금 답할 질문 + 방식), elements, scrub}
export function buildPrompt({ q, msgs = [], mode = 'auto', ctx = {}, roster = [] }) {
  const c = normCtx(ctx);
  const admins = adminNamesOf(roster);
  const all = list(msgs).slice();
  if (!all.some(m => m.id === q.id)) all.push(q);
  all.sort(byTime);
  const thread = threadOf(q, all);
  // 글쓴이 가명 — 관리자 · 관리자(🤖자동) · 검토자1(질문한 사람) · 검토자2…
  const labels = new Map();
  let n = 0;
  const label = m => {
    if (m.tag === 'ai') return '관리자(🤖자동)';
    if (admins.has(m.name)) return '관리자';
    if (!labels.has(m.name)) labels.set(m.name, `검토자${++n}`);
    return labels.get(m.name);
  };
  label(q);
  for (const m of thread) label(m);
  const names = [ADMIN_NAME, ...list(roster).map(x => x && x.n), ...all.map(m => m.name)];
  const scrub = makeScrub(names, admins, labels);
  const scrubStatic = makeScrub(names, admins);   // 고정 부분은 대화마다 달라지지 않게(캐시) — 관리자 / 검토자로만

  const qText = scrub(oneLine(q.text));
  const threadText = thread.map(m => `${m.id === q.id ? '▶ ' : ''}${label(m)}${m.tag === 'q' ? ' [질문]' : ''}: ${scrub(oneLine(m.text))}`).join('\n');
  const codes = findElements([q.text, thread.map(m => m.text).join('\n')], c.elements, 3);
  // 용어: 지금 질문을 먼저(가중) — 질문 글 두 번 + 대화
  const terms = findTerms([q.text, q.text, thread.map(m => m.text).join('\n')], c.glossary, 10);
  const dynamic = [
    '[용어] 질문 · 대화와 가까운 것만 골랐음(없으면 [검토 안내] · [자주 묻는 질문]으로)\n' + (terms.length ? terms.map(x => `- ${x.term}: ${oneLine(x.desc)}`).join('\n') : '(맞는 용어 없음)'),
    '[요소 카드]\n' + (codes.length ? codes.map(k => cardText(k, c.elements[k])).join('\n') : '(질문 · 대화에 나온 데이터 요소 없음)'),
    '[대화] 오래된 것부터 · ▶ = 지금 답할 질문\n' + threadText,
  ].join('\n\n');
  const user = `[지금 답할 질문]\n${label(q)}: ${qText}\n\n${MODE_NOTE[mode] || MODE_NOTE.auto}`;
  // 한 번 더(참고 자료에 이름이 섞여 있어도 보내지 않게)
  return { system: scrubStatic(staticText(c)), dynamic: scrub(dynamic), user: scrub(user), elements: codes, scrub };
}

// ---------- 응답 해석 — 코드 울타리 · 앞뒤 설명이 붙어도 JSON 객체 {kind, text, why}를 찾는다
function matchBrace(s, i) {
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return j;
  }
  return -1;
}
// JSON 문자열 안의 날 줄바꿈 · 탭(모델이 가끔 그대로 씀) → \n · \t
function escCtlInStrings(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      else if (ch < ' ') { out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : ''; continue; }
    } else if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}
function extractJson(s) {
  if (typeof s !== 'string') return null;
  const cands = [];
  for (const m of s.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) cands.push(m[1]);
  cands.push(s);
  for (const c of cands) {
    for (let i = c.indexOf('{'); i >= 0; i = c.indexOf('{', i + 1)) {
      const end = matchBrace(c, i);
      if (end < 0) continue;
      const slice = c.slice(i, end + 1);
      for (const t of [slice, escCtlInStrings(slice)]) {
        try {
          const o = JSON.parse(t);
          if (o && typeof o === 'object' && !Array.isArray(o) && 'kind' in o) return o;
        } catch { /* 다음 { 부터 */ }
      }
    }
  }
  return null;
}
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
// 채팅 글 모양으로(app/api/docs cleanChat과 같은 정리) · 300자 넘으면 299자 + …
export function clampText(t) {
  let s = (typeof t === 'string' ? t : '').replace(/\r\n?/g, '\n').replace(CTRL_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > AI_MAX_TEXT) {
    s = s.slice(0, AI_MAX_TEXT - 1);
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
    s = s.trimEnd() + '…';
  }
  return s;
}
// {kind, text, why} — 틀리면 AiError
export function parseReply(raw) {
  const o = extractJson(raw);
  if (!o) throw new AiError('bad_json');
  const kind = typeof o.kind === 'string' ? o.kind.trim().toLowerCase() : '';
  if (!KINDS.includes(kind)) throw new AiError('bad_kind');
  const text = kind === 'skip' ? '' : clampText(o.text);
  if (kind !== 'skip' && !text) throw new AiError('empty_text');
  return { kind, text, why: typeof o.why === 'string' ? o.why.trim().slice(0, 200) : '' };
}

// ---------- Claude Messages API — text 블록만 씀(생각 블록 등은 버림)
export async function callClaude({ system, dynamic, user }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new AiError('ai_disabled');
  const model = aiModel();
  const thinking = thinkingFor(model);
  let res;
  try {
    res = await fetch(apiUrl(), {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: maxTokensFor(model),
        ...(thinking ? { thinking } : {}),
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }, { type: 'text', text: dynamic }],
        messages: [{ role: 'user', content: user }],
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new AiError(e && e.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    let type = '';
    try { type = String(JSON.parse(raw).error.type || '').replace(/[^a-z_]/g, '').slice(0, 40); } catch { /* 본문 없음 */ }
    throw new AiError(`http_${res.status}${type ? '_' + type : ''}`, res.status);
  }
  let data;
  try { data = JSON.parse(raw); } catch { throw new AiError('bad_response'); }
  const text = list(data && data.content).filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
  if (!text.trim()) throw new AiError('empty');
  return { text, stop: (data && data.stop_reason) || null };
}

// 질문 하나에 답 만들기 → {kind, text, why, model}. mode: 'auto'(자동 답변) | 'draft'(초안)
//   명단을 못 읽으면 글 속 이름을 가릴 수 없으므로 AI를 부르지 않는다
export async function generate({ q, msgs = [], mode = 'auto' }) {
  if (!aiEnabled()) throw new AiError('ai_disabled');
  let roster;
  try { roster = await reviewers(); } catch { throw new AiError('roster_unavailable'); }
  const ctx = await aiContext();
  const p = buildPrompt({ q, msgs, mode, ctx, roster });
  const out = await callClaude(p);
  const r = parseReply(out.text);
  return { kind: r.kind, text: r.kind === 'skip' ? '' : clampText(p.scrub(r.text)), why: r.why, model: aiModel() };
}
