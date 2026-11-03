// Cosmos – version web (Render.com, téléphone, PWA)
// Serveur Node sans dépendance : il sert le jeu de ../ui et le classement partagé.
// Les règles (pseudo, scores, défi du jour) sont les mêmes que la version FiveM (server.lua).
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, "..", "ui");
const WEB_DIR = path.resolve(__dirname, "public");
const DATA_FILE = process.env.COSMOS_DATA_FILE || path.resolve(__dirname, ".data", "cosmos.json");
const PORT = Number(process.env.PORT) || 3000;

const CONFIG = {
  boardSize: 30,
  maxScore: 50_000_000,
  cooldownMs: 2000,
  pseudoMin: 3,
  pseudoMax: 16,
  bannedWords: (process.env.COSMOS_BANNED_WORDS || "admin,staff,modo").split(",").map(w => w.trim().toLowerCase()).filter(Boolean),
  keepDays: 14
};

/* ---------- stockage : Upstash Redis si configuré, sinon fichier JSON ---------- */
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = process.env.COSMOS_REDIS_KEY || "cosmos:data";

let data = { players: {}, daily: {}, stats: {} };

async function redis(cmd) {
  const r = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error("Upstash " + r.status);
  return (await r.json()).result;
}

async function load() {
  try {
    const raw = UPSTASH_URL ? await redis(["GET", REDIS_KEY]) : await fsp.readFile(DATA_FILE, "utf8");
    if (raw) {
      const d = JSON.parse(raw);
      data = { players: d.players || {}, daily: d.daily || {}, stats: d.stats || {} };
    }
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Lecture des données impossible :", e.message);
  }
  console.log(`📂 ${Object.keys(data.players).length} joueur(s) chargé(s) depuis ${UPSTASH_URL ? "Upstash" : DATA_FILE}`);
}

let saveTimer = null, saving = Promise.resolve();
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1500);
}
function saveNow() {
  clearTimeout(saveTimer);
  saving = saving.then(async () => {
    const raw = JSON.stringify(data);
    try {
      if (UPSTASH_URL) await redis(["SET", REDIS_KEY, raw]);
      else {
        await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
        await fsp.writeFile(DATA_FILE + ".tmp", raw);
        await fsp.rename(DATA_FILE + ".tmp", DATA_FILE);
      }
    } catch (e) { console.error("Sauvegarde impossible :", e.message); }
  });
  return saving;
}

function pruneDays() {
  const days = Object.keys(data.daily).sort();
  while (days.length > CONFIG.keepDays) delete data.daily[days.shift()];
  const sdays = Object.keys(data.stats).sort();
  while (sdays.length > CONFIG.keepDays) delete data.stats[sdays.shift()];
}

/* ---------- statistiques : qui joue en ce moment, activité du jour ---------- */
const presence = new Map(); // joueur -> dernier signal (en mémoire seulement)
const ONLINE_MS = 3 * 60 * 1000;
function dayStats(day = today()) {
  const st = data.stats[day] || (data.stats[day] = { players: {}, newPlayers: 0, pseudos: 0 });
  if (!st.recordBy) st.recordBy = {};
  return st;
}
function markActive(key) {
  presence.set(key, Date.now());
  const st = dayStats(), k = key.slice(0, 12);
  if (!st.players[k]) { st.players[k] = 1; pruneDays(); scheduleSave(); }
}
function onlineNow() {
  const limit = Date.now() - ONLINE_MS; let n = 0;
  for (const [k, t] of presence) { if (t >= limit) n++; else presence.delete(k); }
  return n;
}
function statsSnapshot() {
  const days = Object.keys(data.stats).sort().slice(-7).reverse();
  const players = Object.values(data.players);
  return {
    online: onlineNow(),
    today: (() => { const st = dayStats(); return { day: today(), players: Object.keys(st.players).length, newPlayers: st.newPlayers, records: Object.keys(st.recordBy).length, pseudos: st.pseudos, daily: Object.keys(data.daily[today()] || {}).length }; })(),
    total: { players: players.length, named: players.filter(p => p.pseudo).length, best: Math.max(0, ...players.map(p => p.best || 0)) },
    week: days.map(d => ({ day: d, players: Object.keys(data.stats[d].players).length, newPlayers: data.stats[d].newPlayers, records: Object.keys(data.stats[d].recordBy || {}).length })),
    uptime: Math.floor(process.uptime())
  };
}

/* ---------- règles du classement ---------- */
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number(v) || 0)));
const validDay = d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
// jour au fuseau des joueurs (Render tourne en UTC) ; modifiable avec COSMOS_TZ
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: process.env.COSMOS_TZ || "Europe/Paris" });
const addDays = (key, n) => { const t = new Date(key + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
// Série : jours d'affilée avec le défi réussi (3/3), calculée par le serveur
function streakOf(key, day) {
  const d = data.daily[day]?.[key];
  if (d && d.done >= 3) return d.streak || 1;
  const y = data.daily[addDays(day, -1)]?.[key];
  return y && y.done >= 3 ? y.streak || 1 : 0;
}

function cleanPseudo(p) {
  if (typeof p !== "string") return null;
  p = p.normalize("NFC").replace(/\s+/g, " ").trim();
  const len = [...p].length;
  if (len < CONFIG.pseudoMin || len > CONFIG.pseudoMax) return null;
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(p)) return null;
  const low = p.toLowerCase();
  if (CONFIG.bannedWords.some(w => low.includes(w))) return null;
  return p;
}

// Le téléphone garde un jeton secret ; le serveur n'en stocke qu'une empreinte.
function playerKey(req) {
  const tok = req.headers["x-cosmos-player"];
  if (typeof tok !== "string" || !/^[A-Za-z0-9-]{20,64}$/.test(tok)) return null;
  return crypto.createHash("sha256").update(tok).digest("hex").slice(0, 32);
}

const lastCall = new Map();
function tooSoon(key, kind) {
  const k = kind + ":" + key, now = Date.now();
  if (lastCall.has(k) && now - lastCall.get(k) < CONFIG.cooldownMs) return true;
  lastCall.set(k, now);
  if (lastCall.size > 5000) lastCall.clear();
  return false;
}

function getBoard(key, body) {
  const day = validDay(body.dayKey) ? body.dayKey : today();
  const me = data.players[key];
  const named = Object.entries(data.players).filter(([, p]) => p.pseudo);
  const ranked = named.filter(([, p]) => p.best > 0).sort((a, b) => b[1].best - a[1].best);
  const myRank = ranked.findIndex(([id]) => id === key) + 1 || null;
  const all = ranked
    .slice(0, CONFIG.boardSize)
    .map(([id, p], i) => ({ id: id === key ? "me" : "a" + (i + 1), name: p.pseudo, best: p.best, top: p.top, uni: p.uni || 1 }));
  const dayRows = data.daily[day] || {};
  const dayRanked = Object.entries(dayRows)
    .filter(([id]) => data.players[id] && data.players[id].pseudo)
    .sort((a, b) => b[1].best - a[1].best);
  const myDayRank = dayRanked.findIndex(([id]) => id === key) + 1 || null;
  const daily = dayRanked
    .slice(0, CONFIG.boardSize)
    .map(([id, d], i) => ({ id: id === key ? "me" : "d" + (i + 1), name: data.players[id].pseudo, best: d.best, top: d.top, done: d.done, streak: d.done >= 3 ? d.streak || 1 : 0 }));
  const myDay = dayRows[key];
  return {
    me: { id: "me", pseudo: me?.pseudo || null, best: me?.best || 0, dayBest: myDay?.best || 0, done: myDay?.done || 0, rank: myRank, dayRank: myDayRank, streak: streakOf(key, day) },
    requirePseudo: true,
    all,
    daily
  };
}

function setPseudo(key, body, ip) {
  if (!data.players[key] && !allowNewPlayer(ip)) return { ok: false, error: "busy" };
  const pseudo = cleanPseudo(body.pseudo);
  if (!pseudo) return { ok: false, error: "invalid" };
  const low = pseudo.toLowerCase();
  const owner = Object.entries(data.players).find(([id, p]) => id !== key && p.pseudo && p.pseudo.toLowerCase() === low);
  if (owner) return { ok: false, error: "taken" };
  if (tooSoon(key, "pseudo")) return { ok: false, error: "cooldown" };
  if (!data.players[key]) dayStats().newPlayers++;
  if (!data.players[key]?.pseudo) dayStats().pseudos++;
  const p = data.players[key] || (data.players[key] = { best: 0, top: 1 });
  p.pseudo = pseudo;
  p.updatedAt = Date.now();
  scheduleSave();
  return { ok: true, pseudo };
}

function submitScore(key, body, ip) {
  if (tooSoon(key, "score")) return { ok: false, error: "cooldown" };
  if (!data.players[key] && !allowNewPlayer(ip)) return { ok: false, error: "busy" };
  if (!data.players[key]) dayStats().newPlayers++;
  const p = data.players[key] || (data.players[key] = { pseudo: null, best: 0, top: 1 });
  const best = clampInt(body.best, 0, CONFIG.maxScore);
  if (best > p.best) { if (p.best > 0) dayStats().recordBy[key.slice(0, 12)] = 1; p.best = best; p.top = clampInt(body.top, 1, 12); p.uni = clampInt(body.uni, 1, 999); }
  p.updatedAt = Date.now();
  if (validDay(body.dayKey)) {
    const dayBest = clampInt(body.dayBest, 0, CONFIG.maxScore);
    if (dayBest > 0) {
      const day = data.daily[body.dayKey] || (data.daily[body.dayKey] = {});
      const d = day[key] || (day[key] = { best: 0, top: 1, done: 0 });
      if (dayBest > d.best) { d.best = dayBest; d.top = clampInt(body.dayTop, 1, 12); }
      d.done = Math.max(d.done, clampInt(body.done, 0, 3));
      if (d.done >= 3 && !d.streak) {
        const prev = data.daily[addDays(body.dayKey, -1)]?.[key];
        d.streak = (prev && prev.done >= 3 ? prev.streak || 1 : 0) + 1;
      }
      pruneDays();
    }
  }
  scheduleSave();
  return { ok: true };
}

// signal discret envoyé par l'appli ouverte (toutes les 2 minutes), pour savoir qui joue
const ping = () => ({ ok: true });
const API = { getBoard, setPseudo, submitScore, ping };

/* ---------- protection 1 : limites par connexion (contre les scripts) ---------- */
const LIMITS = {
  reqPerMin: Number(process.env.COSMOS_REQ_PER_MIN) || 120,          // requêtes au classement par minute et par connexion
  newPlayersPerHour: Number(process.env.COSMOS_NEW_PER_HOUR) || 20,   // nouveaux joueurs par heure et par connexion
  maxPlayers: Number(process.env.COSMOS_MAX_PLAYERS) || 4000          // plafond total, pour que la base reste petite
};
const hits = new Map();
function clientIp(req) {
  const f = req.headers["x-forwarded-for"]; // Render place l'adresse réelle du joueur ici
  return (typeof f === "string" && f.split(",")[0].trim()) || req.socket.remoteAddress || "?";
}
function bucket(ip) {
  const m = Math.floor(Date.now() / 60000);
  let h = hits.get(ip);
  if (!h) { h = { m, n: 0, hr: Math.floor(m / 60), created: 0 }; hits.set(ip, h); }
  if (h.m !== m) { h.m = m; h.n = 0; }
  if (h.hr !== Math.floor(m / 60)) { h.hr = Math.floor(m / 60); h.created = 0; }
  return h;
}
const allowRequest = ip => ++bucket(ip).n <= LIMITS.reqPerMin;
function allowNewPlayer(ip) {
  const h = bucket(ip);
  if (Object.keys(data.players).length >= LIMITS.maxPlayers) return false;
  if (h.created >= LIMITS.newPlayersPerHour) return false;
  h.created++;
  return true;
}
setInterval(() => { const m = Math.floor(Date.now() / 60000); for (const [ip, h] of hits) if (m - h.m > 60) hits.delete(ip); }, 10 * 60000).unref();

/* ---------- protection 2 : ménage des joueurs fantômes ---------- */
// Un joueur sans pseudo, avec un tout petit score et inactif depuis 7 jours est supprimé.
const CLEAN = { days: Number(process.env.COSMOS_CLEAN_DAYS) || 7, minScore: 5000 };
function cleanup() {
  const limit = Date.now() - CLEAN.days * 864e5;
  let n = 0;
  for (const [id, p] of Object.entries(data.players)) {
    if (!p.updatedAt) { p.updatedAt = Date.now(); continue; } // anciens joueurs : on leur laisse le délai complet
    if (!p.pseudo && (p.best || 0) < CLEAN.minScore && p.updatedAt < limit) {
      delete data.players[id];
      for (const day of Object.values(data.daily)) delete day[id];
      n++;
    }
  }
  if (n) console.log(`🧹 ${n} joueur(s) fantôme(s) supprimé(s)`);
  scheduleSave();
  return n;
}
setInterval(cleanup, 6 * 3600e3).unref();

/* ---------- fichiers statiques ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".css": "text/css; charset=utf-8"
};

// Le jeu est le même fichier que dans le téléphone FiveM ; on y ajoute le pont web.
const HEAD_INJECT = `<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0b0d1a">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" href="/icon-192.png">
<link rel="stylesheet" href="/web.css">
<script src="/web-bridge.js"></script>`;
let indexCache = null;
async function indexHtml() {
  if (indexCache && process.env.NODE_ENV === "production") return indexCache;
  const raw = await fsp.readFile(path.join(UI_DIR, "index.html"), "utf8");
  indexCache = raw.replace("</head>", HEAD_INJECT + "\n</head>");
  return indexCache;
}

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { "Content-Type": type, "X-Content-Type-Options": "nosniff", ...extra });
  res.end(body);
}

async function serveFile(res, file, cache) {
  try {
    const buf = await fsp.readFile(file);
    send(res, 200, buf, MIME[path.extname(file)] || "application/octet-stream", { "Cache-Control": cache });
  } catch {
    send(res, 404, "Introuvable", "text/plain; charset=utf-8");
  }
}

function safeJoin(root, rel) {
  const p = path.resolve(root, "." + rel);
  return p.startsWith(root + path.sep) ? p : null;
}

/* ---------- page de statistiques, protégée par mot de passe ---------- */
// Mot de passe : variable d'environnement COSMOS_ADMIN_PASSWORD (sans elle, la page n'existe pas).
const ADMIN_PASSWORD = process.env.COSMOS_ADMIN_PASSWORD || "";
const adminFails = new Map();
function adminRoute(req, res, p) {
  if (!ADMIN_PASSWORD) return send(res, 404, "Introuvable", "text/plain; charset=utf-8");
  const ip = clientIp(req), f = adminFails.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 3600e3) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) return send(res, 429, "Trop d'essais, réessaie dans une heure.", "text/plain; charset=utf-8");
  const auth = req.headers.authorization || "";
  const given = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
  const ok = given.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ADMIN_PASSWORD));
  if (!ok) {
    if (auth) { f.n++; adminFails.set(ip, f); }
    return send(res, 401, "Mot de passe requis", "text/plain; charset=utf-8", { "WWW-Authenticate": 'Basic realm="Cosmos admin", charset="UTF-8"' });
  }
  const st = statsSnapshot();
  if (p.endsWith(".json")) return send(res, 200, JSON.stringify(st), MIME[".json"], { "Cache-Control": "no-store" });
  return send(res, 200, adminHtml(st), MIME[".html"], { "Cache-Control": "no-store" });
}
const fmtN = n => Number(n).toLocaleString("fr-FR");
function adminHtml(st) {
  const row = w => `<tr><td>${new Date(w.day + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })}</td><td>${w.players}</td><td>${w.newPlayers}</td><td>${w.records}</td></tr>`;
  const up = st.uptime > 3600 ? Math.floor(st.uptime / 3600) + " h" : Math.max(1, Math.floor(st.uptime / 60)) + " min";
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cosmos · Stats</title><meta http-equiv="refresh" content="30"><link rel="icon" href="/icon-192.png">
<style>
:root{--bg:#0b0d1a;--panel:#151a33;--ink:#e9ecff;--muted:#8a92c4;--flare:#ffb35c;--live:#3ccf6a;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px max(16px,env(safe-area-inset-right)) 32px max(16px,env(safe-area-inset-left))}
main{max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
h1{margin:0;font-size:1.4rem}h1 span{color:var(--flare)}
.sub{margin:2px 0 0;color:var(--muted);font-size:.85rem}
.live{display:flex;align-items:center;gap:14px;background:var(--panel);border-radius:16px;padding:16px 18px}
.dot{width:14px;height:14px;border-radius:50%;background:${st.online ? "var(--live)" : "#555b7a"};box-shadow:${st.online ? "0 0 0 6px #3ccf6a33" : "none"};flex:none}
.live b{font-size:2.2rem;line-height:1;font-variant-numeric:tabular-nums}.live small{display:block;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.card{background:var(--panel);border-radius:14px;padding:12px 14px}.card small{color:var(--muted);font-size:.78rem}.card b{display:block;font-size:1.4rem;font-variant-numeric:tabular-nums}
h2{margin:8px 0 0;font-size:.75rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600}
table{width:100%;border-collapse:collapse;background:var(--panel);border-radius:14px;overflow:hidden;font-variant-numeric:tabular-nums}
th,td{padding:9px 12px;text-align:right}th:first-child,td:first-child{text-align:left}th{font-size:.75rem;color:var(--muted);font-weight:600}tr+tr td{border-top:1px solid #ffffff10}
p.note{color:var(--muted);font-size:.8rem;margin:0}
</style></head><body><main>
<div><h1>Cosmos <span>· Stats</span></h1><p class="sub">Mise à jour automatique toutes les 30 secondes</p></div>
<div class="live"><span class="dot"></span><div><b>${st.online}</b><small>joueur${st.online > 1 ? "s" : ""} en train de jouer (dernières 3 minutes)</small></div></div>
<h2>Aujourd'hui</h2>
<div class="grid">
<div class="card"><small>Joueurs actifs</small><b>${st.today.players}</b></div>
<div class="card"><small>Nouveaux joueurs</small><b>${st.today.newPlayers}</b></div>
<div class="card"><small>Joueurs ayant battu leur record</small><b>${st.today.records}</b></div>
<div class="card"><small>Joueurs du défi du jour</small><b>${st.today.daily}</b></div>
</div>
<h2>7 derniers jours</h2>
<table><tr><th>Jour</th><th>Actifs</th><th>Nouveaux</th><th>Records</th></tr>${st.week.map(row).join("") || '<tr><td colspan="4">Pas encore de données</td></tr>'}</table>
<h2>Depuis le début</h2>
<div class="grid">
<div class="card"><small>Joueurs enregistrés</small><b>${fmtN(st.total.players)}</b></div>
<div class="card"><small>Avec un pseudo</small><b>${fmtN(st.total.named)}</b></div>
<div class="card" style="grid-column:1/-1"><small>Meilleur score</small><b>${fmtN(st.total.best)}</b></div>
</div>
<p class="note">Serveur réveillé depuis ${up}. « En train de jouer » compte les appareils dont l'appli est ouverte à l'écran ; la version FiveM n'est pas comptée ici.</p>
</main></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);

  if (p === "/admin" || p === "/admin/stats.json") return adminRoute(req, res, p);

  if (p === "/healthz") return send(res, 200, JSON.stringify({ status: "healthy", uptime: Math.floor(process.uptime()) }), MIME[".json"]);

  if (p.startsWith("/api/nui/")) {
    const fn = API[p.slice(9)];
    if (!fn || req.method !== "POST") return send(res, 404, "{}", MIME[".json"]);
    const ip = clientIp(req);
    if (!allowRequest(ip)) return send(res, 429, JSON.stringify({ ok: false, error: "busy" }), MIME[".json"], { "Retry-After": "60" });
    const key = playerKey(req);
    if (!key) return send(res, 400, JSON.stringify({ ok: false, error: "player" }), MIME[".json"]);
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return send(res, 413, "{}", MIME[".json"]); }
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, "{}", MIME[".json"]); }
    if (!body || typeof body !== "object") body = {};
    markActive(key);
    return send(res, 200, JSON.stringify(fn(key, body, ip)), MIME[".json"], { "Cache-Control": "no-store" });
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "", "text/plain");

  if (p === "/" || p === "/index.html") {
    try { return send(res, 200, await indexHtml(), MIME[".html"], { "Cache-Control": "no-cache" }); }
    catch { return send(res, 500, "Jeu introuvable", "text/plain; charset=utf-8"); }
  }
  if (p.startsWith("/img/")) {
    const f = safeJoin(UI_DIR, p);
    return f ? serveFile(res, f, "public, max-age=604800") : send(res, 404, "", "text/plain");
  }
  const f = safeJoin(WEB_DIR, p);
  if (f && fs.existsSync(f)) return serveFile(res, f, p === "/sw.js" ? "no-cache" : "public, max-age=86400");
  return send(res, 404, "Introuvable", "text/plain; charset=utf-8");
});

await load();
cleanup();
server.listen(PORT, "0.0.0.0", () => console.log(`✅ Cosmos en ligne sur le port ${PORT}`));

async function shutdown(sig) {
  console.log(`${sig} reçu : sauvegarde du classement…`);
  await saveNow();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
