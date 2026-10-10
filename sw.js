// 網銀的 service worker：只負責接收「可以抽卡囉」推播、點通知打開網銀。不快取任何資料。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Alex Private Bank", {
    body: d.body || "", icon: "icon-192.png", badge: "icon-192.png", tag: "draw-ready", data: { url: d.url || "./" },
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = wins.find(w => w.url.startsWith(self.registration.scope));
    if (open) { await open.focus(); return; }
    await self.clients.openWindow(url);
  })());
});
