// 막차알림 서비스 워커: 오프라인 캐시 + 알림 클릭 처리
// 파일을 바꾸면 CACHE 이름의 숫자를 올려 주세요 (예전 캐시가 자동으로 지워짐)
const CACHE = 'makcha-v4';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 앱 파일은 항상 네트워크에서 새로 받고, 정상(200) 응답만 저장.
// 인터넷이 끊겼을 때만 저장해 둔 파일을 사용. (지도 타일·서버 요청 등 외부 요청은 건드리지 않음)
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || Response.error()))
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow('./');
    })
  );
});
