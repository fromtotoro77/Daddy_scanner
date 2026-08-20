/* Daddy Scanner Service Worker v1.0.0
   - 앱 셸: 설치 시 프리캐시
   - CDN(OpenCV.js 8MB 포함)·폰트: 첫 사용 후 캐시 우선 → 두 번째 접속부터 즉시 실행/오프라인 동작 */
const CACHE = 'daddy-scanner-v1.1.0';
const SHELL = [
  './',
  './index.html',
  './app.css?v=1.1.0',
  './app.js?v=1.1.0',
  './manifest.json?v=1.1.0',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const RUNTIME_HOSTS = [
  'cdn.jsdelivr.net',
  'docs.opencv.org',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // CDN·폰트: 캐시 우선 (opencv.js 재다운로드 방지)
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        if (hit) return hit;
        return fetch(e.request).then((res) => {
          if (res.ok || res.type === 'opaque') {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // 앱 셸: 네트워크 우선, 실패 시 캐시 (배포 갱신을 바로 반영하면서 오프라인 대응)
  // HTML 문서는 HTTP 캐시(GitHub Pages 10분)를 우회해 항상 서버에 재검증 → 새 배포 즉시 반영
  if (url.origin === location.origin) {
    const isDoc = e.request.mode === 'navigate' || e.request.destination === 'document';
    const req = isDoc ? new Request(e.request.url, { cache: 'no-cache' }) : e.request;
    e.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
  }
});
