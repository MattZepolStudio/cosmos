// Service worker : le jeu reste jouable sans réseau (le classement, lui, a besoin du serveur)
const CACHE = "cosmos-v27";
const ASTRES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "c", "dark", "neb", "pul"].map(k => `/img/${k}.png`);
const PRECACHE = ["/web-bridge.js", "/web.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", ...ASTRES];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all([
    c.addAll(PRECACHE),
    fetch("/", { cache: "no-store" }).then(r => { if (r.ok && r.headers.get("X-Cosmos-App")) return c.put("/", r); })
  ])).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;

  // Les pages d'administration ne passent jamais par le cache
  if (url.pathname.startsWith("/admin")) return;

  // Page du jeu : on affiche tout de suite la version gardée sur le téléphone (le jeu se lance
  // même si le serveur gratuit dort), et on télécharge la nouvelle version en arrière-plan
  // pour le lancement suivant. Seule la vraie page du jeu est gardée (pas la page d'attente de Render).
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const fresh = fetch(e.request).then(r => {
      if (r.ok && r.headers.get("X-Cosmos-App")) { const copy = r.clone(); caches.open(CACHE).then(c => c.put("/", copy)); }
      return r;
    });
    e.respondWith(caches.match("/").then(hit => {
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      return fresh.catch(() => new Response("Pas de connexion. Ouvre le jeu une première fois avec internet.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
    }));
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
