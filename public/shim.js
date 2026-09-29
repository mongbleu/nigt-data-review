/* window.claude 호환 shim — 검토 화면(review.html)의 앱 스크립트가 런타임에 쓰는 부분만 구현한다.
 *   (scripts/build_page.mjs가 앱 스크립트 바로 앞에 넣는다. 본문이 쓰는 API가 이 범위를 넘으면 빌드가 경고한다.)
 *   use('db')        collection(c).onSnapshot · doc('c/id').onSnapshot · doc('c/id').set
 *   use('user')      id() · can('data.write') · isOwner() · canEdit() · name() · role()   (name·role = 로그인한 검토자 — 웹앱 전용)
 *   use('downloads') save({filename, data})
 * 저장소는 /api/docs (서버가 Supabase에 기록). 구독은 즉시 한 번 읽고, 화면이 보일 때 15초마다 폴링한다.
 */
(() => {
  'use strict';

  const POLL_MS = 15000;
  // 5분 넘게 조작이 없으면 1분마다만 확인한다(열어 둔 채 자리를 비운 탭이 서버 호출 한도를 쓰지 않게). 다시 만지면 바로 따라잡는다.
  const IDLE_AFTER_MS = 5 * 60 * 1000;
  const IDLE_POLL_MS = 60 * 1000;
  const REFRESH_AFTER_SET_MS = 800;
  const KEEPALIVE_MAX_BYTES = 60000; // 페이지를 닫는 중에도 저장 요청이 끝나도록 (브라우저 한도 64KB)
  const COLLS = new Set(['reviews', 'answers', 'config']);
  const ID_RE = /^[A-Za-z0-9_\-]{1,80}$/;

  const enc = new TextEncoder();
  const fail = (code, message) => Object.assign(new Error(message || code), { code });
  const report = (e) => { if (typeof window.reportError === 'function') window.reportError(e); else setTimeout(() => { throw e; }); };

  let leaving = false;
  function toLogin() {
    if (leaving) return;
    leaving = true;
    location.assign('/login');
  }

  // app.js보다 먼저 등록되므로, app.js가 pagehide에서 저장을 보낼 때는 이미 true
  let unloading = false;
  window.addEventListener('pagehide', () => { unloading = true; });
  window.addEventListener('pageshow', () => { unloading = false; });

  // ---------- HTTP
  async function call(method, url, payload) {
    const init = { method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (payload !== undefined) {
      init.body = JSON.stringify(payload);
      init.headers['Content-Type'] = 'application/json';
      // 탭을 닫거나 떠나는 중(pagehide·hidden)에 보내는 저장은 페이지가 사라져도 끝나도록 keepalive
      if ((unloading || document.visibilityState === 'hidden') && enc.encode(init.body).length <= KEEPALIVE_MAX_BYTES) init.keepalive = true;
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw fail('unavailable', 'network error');
    }
    if (res.status === 401) { toLogin(); throw fail('unauthenticated', 'login required'); }
    if (res.status === 403) {
      let why = '';
      try { why = ((await res.json()) || {}).error || ''; } catch (e) { /* 본문 없음 */ }
      // 담당이 아닌 요소 저장 → 그 요소만 거절(앱이 알림) · 보기 전용·권한 없음 → 공용 저장 불가로 처리
      throw fail(why === 'not_assigned' ? 'permission_denied' : 'invalid_argument', why || 'forbidden');
    }
    if (res.status === 413) throw fail('quota_exceeded', 'payload too large');
    if (res.status >= 500) throw fail('unavailable', `server error ${res.status}`);
    if (!res.ok) throw fail('failed_precondition', `request failed ${res.status}`);
    try {
      return await res.json();
    } catch (e) {
      throw fail('unavailable', 'invalid response');
    }
  }

  // 키 순서와 무관한 비교용 직렬화 (Postgres jsonb는 키 순서를 바꾼다)
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  // ---------- 컬렉션 채널 (컬렉션마다 하나: 캐시 · 구독자 · 폴링)
  const channels = new Map();
  function channel(coll) {
    let ch = channels.get(coll);
    if (!ch) {
      // localWrites: id -> 이 탭의 저장이 서버에서 확인된 시각(performance.now). 그보다 먼저 시작한 조회 결과로는 덮어쓰지 않는다.
      ch = { coll, docs: new Map(), localWrites: new Map(), subs: new Set(), loaded: false, cursor: null, inflight: null, again: false, failing: false, timer: null, refreshTimer: null, lastTry: 0 };
      channels.set(coll, ch);
    }
    return ch;
  }

  const docSnap = (ch, id) => {
    const d = ch.docs.get(id);
    return d ? { id, exists: true, data: () => JSON.parse(d.json) } : { id, exists: false, data: () => undefined };
  };
  const colSnap = (ch) => ({ docs: [...ch.docs.keys()].sort().map(id => docSnap(ch, id)) });

  function deliver(ch, sub) {
    try { sub.cb(sub.id == null ? colSnap(ch) : docSnap(ch, sub.id)); } catch (e) { report(e); }
  }
  function emit(ch, changed) { // changed: 바뀐 id 집합, null이면 전부
    for (const sub of [...ch.subs]) {
      if (sub.id == null || !changed || changed.has(sub.id)) deliver(ch, sub);
    }
  }

  // started: 이 조회를 보낸 시각. 이 탭이 그 뒤에 저장을 확인한 문서는 이 결과가 더 오래됐을 수 있어 건너뛴다.
  function merge(ch, docs, full, started) {
    const changed = new Set();
    const stale = id => { const w = ch.localWrites.get(id); return w !== undefined && started < w; };
    if (full) {
      const seen = new Set(docs.map(d => d && d.id));
      for (const id of [...ch.docs.keys()]) if (!seen.has(id) && !stale(id)) { ch.docs.delete(id); changed.add(id); }
    }
    for (const d of docs) {
      if (!d || typeof d.id !== 'string') continue;
      if (stale(d.id)) continue;
      ch.localWrites.delete(d.id);
      const json = canon(d.body === undefined ? null : d.body);
      const cur = ch.docs.get(d.id);
      if (!cur || cur.json !== json) changed.add(d.id);
      ch.docs.set(d.id, { json, updated_at: d.updated_at || null });
    }
    return changed;
  }

  function refresh(ch) {
    if (ch.inflight) { ch.again = true; return ch.inflight; }
    ch.lastTry = Date.now();
    ch.inflight = (async () => {
      try {
        const full = !ch.loaded || !ch.cursor;
        const url = '/api/docs?coll=' + encodeURIComponent(ch.coll) + (full ? '' : '&since=' + encodeURIComponent(ch.cursor));
        const started = performance.now();
        const r = await call('GET', url);
        const docs = r && Array.isArray(r.docs) ? r.docs : [];
        const changed = merge(ch, docs, full, started);
        if (r && typeof r.cursor === 'string' && r.cursor) ch.cursor = r.cursor;
        const first = !ch.loaded;
        ch.loaded = true;
        ch.failing = false;
        if (first) emit(ch, null); else if (changed.size) emit(ch, changed);
      } catch (e) {
        if (e && e.code === 'unauthenticated') return;
        if (!ch.failing) { // 실패가 이어지는 동안에는 한 번만 알린다
          ch.failing = true;
          for (const sub of [...ch.subs]) if (typeof sub.err === 'function') { try { sub.err(e); } catch (x) { report(x); } }
        }
      } finally {
        ch.inflight = null;
        if (ch.again) { ch.again = false; refresh(ch); }
      }
    })();
    return ch.inflight;
  }

  function subscribe(coll, sub) {
    const ch = channel(coll);
    ch.subs.add(sub);
    if (!ch.timer) ch.timer = setInterval(() => { if (document.visibilityState === 'visible' && (!idle() || Date.now() - ch.lastTry >= IDLE_POLL_MS)) refresh(ch); }, POLL_MS);
    if (ch.loaded) setTimeout(() => { if (ch.subs.has(sub)) deliver(ch, sub); }, 0);
    else if (!ch.inflight) { ch.failing = false; refresh(ch); } // 미리 받기가 실패했어도 새 구독자에게는 오류를 알린다
    return () => {
      ch.subs.delete(sub);
      if (!ch.subs.size && ch.timer) { clearInterval(ch.timer); ch.timer = null; }
    };
  }

  let lastActive = Date.now();
  const idle = () => Date.now() - lastActive >= IDLE_AFTER_MS;
  const onActive = () => {
    const wasIdle = idle();
    lastActive = Date.now();
    if (wasIdle && document.visibilityState === 'visible') for (const ch of channels.values()) if (ch.subs.size && Date.now() - ch.lastTry >= POLL_MS) refresh(ch);
  };
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus']) window.addEventListener(ev, onActive, { capture: true, passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    for (const ch of channels.values()) if (ch.subs.size && Date.now() - ch.lastTry >= POLL_MS) refresh(ch);
  });

  function scheduleRefresh(ch) {
    clearTimeout(ch.refreshTimer);
    ch.refreshTimer = setTimeout(() => { ch.refreshTimer = null; if (ch.subs.size || ch.loaded) refresh(ch); }, REFRESH_AFTER_SET_MS);
  }

  function checkColl(coll) {
    if (!COLLS.has(coll)) throw fail('invalid_argument', 'unknown collection: ' + coll);
    return coll;
  }
  function parsePath(p) {
    const s = String(p || ''), i = s.indexOf('/');
    const coll = i > 0 ? s.slice(0, i) : '', id = i > 0 ? s.slice(i + 1) : '';
    checkColl(coll);
    if (!ID_RE.test(id)) throw fail('invalid_argument', 'invalid document id');
    return { coll, id };
  }

  async function setDoc(coll, id, body) {
    try {
      await call('POST', '/api/docs', { coll, id, body });
    } catch (e) {
      // 세션 만료로 로그인 화면으로 가기 전, 검토 내용을 app.js의 임시 저장 자리에 남겨 다시 들어오면 이어서 저장되게 한다
      if (e && e.code === 'unauthenticated' && coll === 'reviews' && body && (body.kind === 'd' || body.kind === 'e')) {
        try { localStorage.setItem('rv-draft-' + id, JSON.stringify(body)); } catch (x) { /* 저장소 차단 */ }
      }
      throw e;
    }
    // 서버 저장이 끝난 내용을 구독자에게 바로 반영하고, 800ms 뒤 서버에서 다시 읽는다
    const ch = channel(coll);
    ch.localWrites.set(id, performance.now());
    const json = canon(JSON.parse(JSON.stringify(body)));
    const cur = ch.docs.get(id);
    if (!cur || cur.json !== json) {
      ch.docs.set(id, { json, updated_at: cur ? cur.updated_at : null });
      if (ch.loaded) emit(ch, new Set([id]));
    }
    scheduleRefresh(ch);
  }

  const db = {
    collection(coll) {
      checkColl(coll);
      return { onSnapshot: (cb, err) => subscribe(coll, { id: null, cb, err }) };
    },
    doc(p) {
      const { coll, id } = parsePath(p);
      return {
        onSnapshot: (cb, err) => subscribe(coll, { id, cb, err }),
        set: (body) => setDoc(coll, id, body),
      };
    },
  };

  // ---------- user
  let uid = null;
  function pseudoId() {
    if (uid) return uid;
    try { uid = localStorage.getItem('nr-uid'); } catch (e) { uid = null; }
    if (!uid || !/^u_[A-Za-z0-9]{6,64}$/.test(uid)) {
      let rnd = '';
      try {
        const a = new Uint8Array(12);
        crypto.getRandomValues(a);
        rnd = Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
      } catch (e) {
        rnd = Math.random().toString(36).slice(2) + Date.now().toString(36);
      }
      uid = 'u_' + rnd;
      try { localStorage.setItem('nr-uid', uid); } catch (e) { /* 세션 메모리에만 둔다 */ }
    }
    return uid;
  }

  let rolePromise = null;
  function role() {
    if (!rolePromise) {
      rolePromise = call('GET', '/api/session').then(r => ({ role: (r && r.role) || null, name: (r && r.name) || null }), e => { rolePromise = null; throw e; });
    }
    return rolePromise;
  }

  const user = {
    id: async () => pseudoId(),
    can: async (cap) => cap === 'data.write' && ['adm', 'rv'].includes((await role()).role),
    isOwner: async () => (await role()).role === 'adm',
    canEdit: async () => (await role()).role === 'adm',
    name: async () => (await role()).name,
    role: async () => (await role()).role,
  };

  // ---------- downloads
  const MIME = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv;charset=utf-8',
    json: 'application/json',
    txt: 'text/plain;charset=utf-8',
  };
  const downloads = {
    async save(opts) {
      const { filename, data } = opts || {};
      const name = String(filename || 'download').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180) || 'download';
      const ext = ((name.match(/\.([A-Za-z0-9]+)$/) || [])[1] || '').toLowerCase();
      const blob = data instanceof Blob ? data : new Blob([data == null ? '' : data], { type: MIME[ext] || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { status: 'saved' };
    },
  };

  const NS = { db, user, downloads };
  Object.defineProperty(window, 'claude', {
    value: Object.freeze({ use: async (name) => NS[name] || null }),
    writable: false,
    configurable: false,
  });

  // app.js가 부팅하는 동안 미리 받아 둔다 (구독이 붙으면 바로 전달)
  role().catch(() => {});
  for (const c of COLLS) refresh(channel(c));
})();
