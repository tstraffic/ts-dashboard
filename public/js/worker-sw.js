// Worker Portal — Service Worker (PWA + push)
// Bumped to v2 for push handler. Old caches are wiped in activate.
const CACHE_NAME = 'ts-worker-v2';

// Install — cache core assets
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll([
        '/css/worker.css',
        '/js/worker.js',
        '/images/logo-colour.jpg',
      ]);
    })
  );
  self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(name) { return name !== CACHE_NAME; })
             .map(function(name) { return caches.delete(name); })
      );
    })
  );
  self.clients.claim();
});

// Fetch — network-first strategy (always try network, fallback to cache)
self.addEventListener('fetch', function(event) {
  // Only handle same-origin GET requests
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(event.request).then(function(response) {
      // Cache successful responses for offline use
      if (response.ok) {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, responseClone);
        });
      }
      return response;
    }).catch(function() {
      // Network failed — try cache
      return caches.match(event.request);
    })
  );
});

// Push — show shift reminder / generic notifications
self.addEventListener('push', function(event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'T&S Notification', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'T&S Notification';
  const options = {
    body: data.body || '',
    icon: '/images/logo-colour.jpg',
    badge: '/images/logo-colour.jpg',
    tag: data.type || 'general',
    data: { url: data.url || '/w/home' },
    vibrate: [180, 80, 180],
    requireInteraction: data.type === 'shift_reminder_24h',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification click — open or focus the worker portal at the right URL
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/w/home';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (const c of list) {
        if (c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
          c.navigate(url); return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
