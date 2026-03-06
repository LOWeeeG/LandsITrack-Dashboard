// ─────────────────────────────────────────────────────────────
//  LandsITrack Service Worker — Auto Cache-Busting
//
//  HOW IT WORKS:
//  The service worker fetches /LandsITrack-Dashboard/version.json
//  on every install/activate. If the version string has changed
//  since the last install, ALL old caches are deleted and the
//  fresh files are downloaded.
//
//  YOU NEVER NEED TO MANUALLY BUMP A VERSION NUMBER.
//  Just push your changes to GitHub — version.json is generated
//  automatically by the page itself on each deploy.
// ─────────────────────────────────────────────────────────────

const BASE      = '/LandsITrack-Dashboard';
const VER_URL   = BASE + '/version.json';
const CACHE_PFX = 'landsitrack-';

// Core app shell — these are cached on install
const SHELL = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/manifest.json',
  BASE + '/icon-192.png',
  BASE + '/icon-512.png',
];

// Never cache these — always fetch live
const NETWORK_ONLY = [
  'api.thingspeak.com',
  'firestore.googleapis.com',
  'firebase',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
];

function isNetworkOnly(url) {
  return NETWORK_ONLY.some(d => url.includes(d));
}

// ── Install: fetch version, cache shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      // Get current version from server
      let version = 'v-' + Date.now(); // fallback
      try {
        const r = await fetch(VER_URL + '?t=' + Date.now(), { cache: 'no-store' });
        if (r.ok) {
          const data = await r.json();
          version = data.version || version;
        }
      } catch(e) { /* use fallback */ }

      const cacheName = CACHE_PFX + version;
      const cache = await caches.open(cacheName);
      try {
        await cache.addAll(SHELL);
      } catch(e) {
        console.warn('[SW] Shell cache partial fail:', e);
      }
      // Store active version so activate can compare
      await self.registration.navigationPreload?.disable?.();
      // Use IndexedDB-free approach: store in a special cache entry
      const metaCache = await caches.open(CACHE_PFX + 'meta');
      await metaCache.put('active-version', new Response(version));

      self.skipWaiting();
    })()
  );
});

// ── Activate: delete ALL old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      // Get what we just installed
      let newVersion = 'unknown';
      try {
        const metaCache = await caches.open(CACHE_PFX + 'meta');
        const r = await metaCache.match('active-version');
        if (r) newVersion = await r.text();
      } catch(e) {}

      const newCacheName = CACHE_PFX + newVersion;

      // Delete every cache that isn't the current one or meta
      await Promise.all(
        keys
          .filter(k => k !== newCacheName && k !== CACHE_PFX + 'meta')
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      );

      await clients.claim();
    })()
  );
});

// ── Fetch: network-first for HTML, cache-first for assets ──
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Always go to network for API calls, Firebase, CDN fonts
  if (isNetworkOnly(url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Network-first for HTML pages (so updates are always fresh)
  if (event.request.mode === 'navigate' ||
      event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      (async () => {
        try {
          const networkRes = await fetch(event.request);
          if (networkRes.ok) {
            // Update cache with fresh copy
            const keys = await caches.keys();
            const appCache = keys.find(k => k.startsWith(CACHE_PFX) && k !== CACHE_PFX + 'meta');
            if (appCache) {
              const cache = await caches.open(appCache);
              cache.put(event.request, networkRes.clone());
            }
          }
          return networkRes;
        } catch(e) {
          // Offline fallback
          const cached = await caches.match(event.request);
          return cached || caches.match(BASE + '/index.html');
        }
      })()
    );
    return;
  }

  // Cache-first for everything else (icons, manifest)
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(res => {
        if (res.ok) {
          caches.keys().then(keys => {
            const appCache = keys.find(k => k.startsWith(CACHE_PFX) && k !== CACHE_PFX + 'meta');
            if (appCache) caches.open(appCache).then(c => c.put(event.request, res.clone()));
          });
        }
        return res;
      });
    })
  );
});

// ── Message: force update from app ──
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
