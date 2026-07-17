/* RegisterDesk offline check-in service worker.
 *
 * Scope is limited to what an operator needs to keep scanning offline:
 *   • the check-in route shell (network-first → cache → offline page)
 *   • Next.js static assets incl. the @zxing scanner chunk (stale-while-revalidate)
 *   • the attendee cache endpoint (network-first → cache)
 *
 * Security: admin pages and admin/auth APIs are NEVER cached or intercepted —
 * they always go straight to the network.
 */

const VERSION     = 'rd-checkin-v2';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const DATA_CACHE  = `${VERSION}-data`;
const OFFLINE_URL = '/checkin-offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll([OFFLINE_URL])).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isAdmin(pathname) {
  return pathname.startsWith('/admin') || pathname.startsWith('/api/admin');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch cross-origin
  if (isAdmin(url.pathname)) return;                  // security: do not cache admin

  // Attendee cache endpoint — network-first, fall back to last good copy.
  if (url.pathname === '/api/checkin/cache') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(DATA_CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((c) => c || Response.error()))
    );
    return;
  }

  // App build assets — NETWORK-FIRST so the CURRENT build always loads; the cache
  // is only an offline fallback. (Cache-first here served a previous build's
  // chunks/app-shell on every route, rendering stale content — e.g. the old
  // homepage — over the fresh page after hydration.)
  if (url.pathname.startsWith('/_next/static') || /\.(?:js|css|woff2?|svg|png|jpg|jpeg|webp|ico)$/.test(url.pathname)) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(ASSET_CACHE).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Check-in navigations — network-first, fall back to cached shell, then offline page.
  if (req.mode === 'navigate' && url.pathname.includes('/checkin')) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((c) => c || caches.match(OFFLINE_URL)))
    );
    return;
  }
});
