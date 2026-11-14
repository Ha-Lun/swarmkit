// SwarmKit service worker: Web Push only. No fetch handler, no caching.
// A push carries { title, body, tag, url, test? } (see PushPayload in src/shared/types.ts).

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function parsePayload(event) {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object') data = {};
  return {
    title: typeof data.title === 'string' && data.title ? data.title : 'SwarmKit',
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' && data.tag ? data.tag : 'swarmkit',
    url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/',
    test: data.test === true,
  };
}

// Chrome shows its own generic notification for a push that shows none, unless a
// focused, visible window exists. So suppressing is only safe in exactly that case.
// Android Chrome keeps reporting an installed app as focused while the screen is
// locked, so there a push is always shown.
async function dashboardIsInView() {
  if (/Android/i.test(self.navigator.userAgent)) return false;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.some((c) => c.focused === true && c.visibilityState === 'visible');
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const p = parsePayload(event);
      if (!p.test && (await dashboardIsInView())) return;
      await self.registration.showNotification(p.title, {
        body: p.body,
        tag: p.tag,
        renotify: true,
        icon: '/icon-192.png',
        badge: '/badge-96.png',
        data: { url: p.url },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url;
  const url = typeof raw === 'string' && raw.startsWith('/') ? raw : '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'swarmkit-open', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
