/* 서비스 워커(/sw.js · 10/1) — 관리자 휴대폰 알림(웹 푸시) 전용. 캐시 · 오프라인 저장 · 요청 가로채기(fetch) 없음 — 검토 기록은 늘 서버에.
 *   push: 서버(lib/push.js)가 보낸 {title, body, tag, url}을 알림으로 띄운다.
 *   notificationclick: 알림을 닫고, 열려 있는 검토 창구 창으로 가거나 없으면 새 창(url, 기본 /)을 연다.
 */
'use strict';

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

// 같은 사이트 안 주소만(/…)
const safeUrl = u => (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? u : '/');

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  if (!d || typeof d !== 'object') d = {};
  const title = typeof d.title === 'string' && d.title ? d.title : '데이터 검토';
  const body = typeof d.body === 'string' ? d.body : '';
  const tag = typeof d.tag === 'string' ? d.tag : '';
  event.waitUntil(self.registration.showNotification(title, { body, icon: '/icon-192.png', badge: '/icon-192.png', tag, data: { url: safeUrl(d.url) } }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if ('focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
    return undefined;
  })());
});
