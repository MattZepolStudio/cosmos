// Service worker : le jeu reste jouable sans réseau (le classement, lui, a besoin du serveur)
const CACHE = "cosmos-v2";
const ASTRES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "c"].map(k => `/img/${k}.png`);
const PRECACHE = ["/", "/web-bridge.js", "/web.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", ...ASTRES];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;

  // Page du jeu : réseau d'abord (pour recevoir les mises à jour), cache si hors ligne
  if (e.request.mode === "navigate" || url.pathname === "/") {
    e.respondWith(
      fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put("/", copy)); return r; })
        .catch(() => caches.match("/"))
    );
    return;
  }

  // Images, polices et fichiers fixes : cache d'abord
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }))
  );
});
