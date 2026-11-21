// Earnings Tracker service worker: precaches everything so the app works with no connection.
// Bump VERSION whenever you change any app file to force a clean refresh.
const VERSION = 'v10';
const CACHE = 'earnings-tracker-' + VERSION;
const FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('earnings-tracker-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Serve from cache instantly, refresh the cache quietly in the background when online.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      const network = fetch(req).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => null);
      if (hit) { e.waitUntil(network); return hit; }
      return network.then(res => res || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
    })
  );
});

// ---- Payment day alerts (checked in the background by Android about twice a day) ----
function idbGet(key) {
  return new Promise(res => {
    const o = indexedDB.open('earnings-reminders', 1);
    o.onupgradeneeded = () => o.result.createObjectStore('kv');
    o.onsuccess = () => { const db = o.result, r = db.transaction('kv').objectStore('kv').get(key); r.onsuccess = () => { db.close(); res(r.result); }; r.onerror = () => res(undefined); };
    o.onerror = () => res(undefined);
  });
}
function idbSet(key, val) {
  return new Promise(res => {
    const o = indexedDB.open('earnings-reminders', 1);
    o.onupgradeneeded = () => o.result.createObjectStore('kv');
    o.onsuccess = () => { const db = o.result, tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => res(); };
    o.onerror = () => res();
  });
}
async function checkPayments() {
  if (!(await idbGet('enabled'))) return;
  const weeks = (await idbGet('weeks')) || [], done = (await idbGet('notified')) || [];
  const t = new Date(), tk = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  const due = weeks.filter(w => !w.paid && w.amount > 0 && w.id <= tk && !done.includes(w.id));
  for (const w of due) {
    await self.registration.showNotification('Payment day', {
      body: '$' + w.amount + ' is due. Open Earnings and mark it received once it arrives.',
      tag: 'pay-' + w.id, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: './#/pay' }
    });
    done.push(w.id);
  }
  if (due.length) await idbSet('notified', done);
}
async function checkGoals() {
  if (!(await idbGet('goalsEnabled'))) return;
  const now = new Date();
  if (now.getHours() < 8) return;
  const tk = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  if ((await idbGet('goalsNotified')) === tk) return;
  const open = ((await idbGet('goals')) || []).filter(g => g.saved < g.target);
  if (!open.length) return;
  const mid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const g = open[Math.floor((mid.getTime() - mid.getTimezoneOffset() * 60000) / 864e5) % open.length];
  const m = n => '$' + (Number.isInteger(n) ? n : n.toFixed(2));
  const left = Math.round((g.target - g.saved) * 100) / 100;
  let hint = m(left) + ' to go.';
  if (g.deadline) {
    const p = g.deadline.split('-').map(Number), days = Math.round((new Date(p[0], p[1] - 1, p[2]) - mid) / 864e5);
    hint = days < 0 ? 'The target date has passed. ' + m(left) + ' still to go.' : 'Save about ' + m(Math.ceil(left / (days + 1) * 100) / 100) + ' a day to reach it.';
  }
  await self.registration.showNotification('Goal check-in', {
    body: g.name + ': ' + m(g.saved) + ' of ' + m(g.target) + ' (' + Math.round(g.saved / g.target * 100) + '%). ' + hint,
    tag: 'goals-daily', icon: 'icon-192.png', badge: 'icon-192.png', data: { url: './#/goals' }
  });
  await idbSet('goalsNotified', tk);
}
self.addEventListener('periodicsync', e => { if (e.tag === 'payment-check') e.waitUntil(Promise.all([checkPayments(), checkGoals()])); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './#/pay';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { if (c.navigate) c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
