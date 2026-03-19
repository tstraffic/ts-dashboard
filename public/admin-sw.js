// T&S Admin Dashboard Service Worker — Network-first with offline fallback
const CACHE_NAME = 'ts-admin-v20';
const OFFLINE_URL = '/offline.html';

// Assets to pre-cache
const PRECACHE_URLS = [
  '/css/custom.css',
  '/js/app.js',
  '/images/logo-colour.jpg',
  OFFLINE_URL
];

// Install — pre-cache essential assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network-first for pages, cache-first for static assets
self.addEventListener('fetch', event => {
  const { request } = event;

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Never cache induction pages — always go to network
  if (request.url.includes('/induction')) return;

  // Static assets (CSS, JS, images) — cache-first
  if (request.url.match(/\.(css|js|jpg|jpeg|png|svg|ico|woff2?)(\?.*)?$/)) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // HTML pages — network-first with offline fallback
  if (request.headers.get('accept') && request.headers.get('accept').includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Cache successful page responses
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Try cached version first, then offline page
          return caches.match(request).then(cached => cached || caches.match(OFFLINE_URL));
        })
    );
    return;
  }

  // API/other requests — network only
  event.respondWith(fetch(request));
});

// ===== Push Notification Handler =====
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: 'T&S Notification', body: event.data.text() };
  }

  const title = data.title || 'T&S Operations';
  const options = {
    body: data.body || '',
    icon: '/images/logo-colour.jpg',
    badge: '/images/logo-colour.jpg',
    tag: data.type || 'general',
    renotify: true,
    data: { url: data.url || '/notifications' },
    actions: [
      { action: 'open', title: 'View' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Handle notification click — open the relevant page
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : '/notifications';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Focus existing tab if one is open
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Otherwise open new tab
      return clients.openWindow(url);
    })
  );
});
