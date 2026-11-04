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

let data = { players: {}, daily: {}, stats: {}, log: [] };

async function redis(cmd) {
  const r = await fetch(UPSTASH_URL, {
    signal: AbortSignal.timeout(10000), // jamais d'attente infinie si Upstash ne répond pas
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error("Upstash " + r.status);
  return (await r.json()).result;
}

// Tant que le classement n'a pas pu être lu, on n'écrit JAMAIS : sinon un classement vide
// remplacerait le vrai (par exemple si Upstash ne répond pas au démarrage).
let loaded = false;
function mergeInto(base, extra) {
  // garde ce qui a été joué pendant que le classement était injoignable
  for (const [id, p] of Object.entries(extra.players)) {
    const b = base.players[id];
    if (!b) base.players[id] = p;
    else { if ((p.best || 0) > (b.best || 0)) Object.assign(b, { best: p.best, top: p.top, uni: p.uni }); if (p.pseudo && !b.pseudo) b.pseudo = p.pseudo; }
  }
  for (const [day, rows] of Object.entries(extra.daily)) {
    const d = base.daily[day] || (base.daily[day] = {});
    for (const [id, r] of Object.entries(rows)) if (!d[id] || r.best > d[id].best || r.done > d[id].done) d[id] = { ...d[id], ...r };
  }
  for (const [day, st] of Object.entries(extra.stats)) if (!base.stats[day]) base.stats[day] = st;
  return base;
}
async function load() {
  try {
    const raw = UPSTASH_URL ? await redis(["GET", REDIS_KEY]) : await fsp.readFile(DATA_FILE, "utf8");
    let fresh = { players: {}, daily: {}, stats: {}, log: [] };
    if (raw) {
      const d = JSON.parse(raw);
      fresh = { players: d.players || {}, daily: d.daily || {}, stats: d.stats || {}, log: Array.isArray(d.log) ? d.log : [] };
    }
    data = mergeInto(fresh, data);
    loaded = true;
  } catch (e) {
    if (e.code === "ENOENT") { loaded = true; }
    else {
      console.error("Lecture du classement impossible, nouvel essai dans 30 s :", e.message);
      setTimeout(() => load().then(() => { if (loaded) { cleanup(); scheduleSave(); } }), 30000).unref();
      return;
    }
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
  if (!loaded) { console.error("Sauvegarde annulée : le classement n'a pas encore pu être lu."); return saving; }
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
    me: { id: "me", pseudo: me?.pseudo || null, best: me?.best || 0, dayBest: myDay?.best || 0, done: myDay?.done || 0, rank: myRank, dayRank: myDayRank, streak: streakOf(key, day), rev: me?.rev || 0 },
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
  // score modifié depuis la page admin : le jeu doit d'abord relire le classement
  if (p.rev && Number(body.rev) !== p.rev) return { ok: false, error: "stale" };
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
/* JoSky est lu sur sa propre page /admin/stats.json, pour tout voir au même endroit.
   Variables : JOSKY_URL (ex. https://josky-xxxx.onrender.com) et JOSKY_ADMIN_PASSWORD. */
const JOSKY_URL = (process.env.JOSKY_URL || "").replace(/\/+$/, "");
const JOSKY_PASSWORD = process.env.JOSKY_ADMIN_PASSWORD || "";
let joskyCache = { at: 0, value: null };
async function joskyStats() {
  if (!JOSKY_URL || !JOSKY_PASSWORD) return { state: "off" };
  if (Date.now() - joskyCache.at < 10000 && joskyCache.value) return joskyCache.value;
  let value;
  try {
    const r = await fetch(JOSKY_URL + "/admin/stats.json", {
      headers: { Authorization: "Basic " + Buffer.from("admin:" + JOSKY_PASSWORD).toString("base64") },
      signal: AbortSignal.timeout(8000)
    });
    value = r.ok ? { state: "ok", ...(await r.json()) } : { state: r.status === 401 ? "password" : r.status === 404 ? "nopage" : "error", status: r.status };
  } catch { value = { state: "asleep" }; }
  joskyCache = { at: Date.now(), value };
  return value;
}
const esc = v => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function adminAuth(req, res) {
  if (!ADMIN_PASSWORD) { send(res, 404, "Introuvable", "text/plain; charset=utf-8"); return false; }
  const ip = clientIp(req), f = adminFails.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 3600e3) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) { send(res, 429, "Trop d'essais, réessaie dans une heure.", "text/plain; charset=utf-8"); return false; }
  const auth = req.headers.authorization || "";
  const given = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
  const ok = given.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ADMIN_PASSWORD));
  if (!ok) {
    if (auth) { f.n++; adminFails.set(ip, f); }
    send(res, 401, "Mot de passe requis", "text/plain; charset=utf-8", { "WWW-Authenticate": 'Basic realm="Stats de mes jeux", charset="UTF-8"' });
    return false;
  }
  return true;
}

/* ---------- gestion des joueurs (page /admin, onglet Joueurs) ---------- */
function playersList() {
  const day = data.daily[today()] || {};
  const ranked = Object.entries(data.players).filter(([, p]) => p.pseudo && p.best > 0).sort((a, b) => b[1].best - a[1].best);
  const rank = new Map(ranked.map(([id], i) => [id, i + 1]));
  return Object.entries(data.players)
    .filter(([, p]) => p.pseudo || p.best > 0)
    .map(([id, p]) => ({ id, pseudo: p.pseudo || null, best: p.best || 0, uni: p.uni || 1, rank: rank.get(id) || null, seen: p.updatedAt || 0, online: (presence.get(id) || 0) >= Date.now() - ONLINE_MS, dayBest: day[id]?.best || 0, done: day[id]?.done || 0, streak: streakOf(id, today()) }))
    .sort((a, b) => b.best - a.best);
}
function bumpRev(p) { p.rev = (p.rev || 0) + 1; p.updatedAt = Date.now(); }
function adminLog(text) {
  data.log.unshift({ at: Date.now(), text });
  data.log.length = Math.min(data.log.length, 50);
}
const ADMIN_ACTIONS = {
  setScore({ id, best }) {
    const p = data.players[id]; if (!p) return "Joueur introuvable.";
    const v = clampInt(best, 0, CONFIG.maxScore), old = p.best || 0;
    p.best = v; if (!v) { p.top = 1; p.uni = 1; }
    bumpRev(p); adminLog(`Score de ${p.pseudo || "anonyme"} : ${fmtN(old)} → ${fmtN(v)}`);
  },
  resetScore({ id }) { return ADMIN_ACTIONS.setScore({ id, best: 0 }); },
  clearDaily({ id }) {
    const p = data.players[id], d = data.daily[today()]; if (!p) return "Joueur introuvable.";
    if (!d || !d[id]) return "Ce joueur n'a pas de score au défi du jour.";
    delete d[id]; bumpRev(p); adminLog(`Défi du jour effacé pour ${p.pseudo || "anonyme"}`);
  },
  rename({ id, pseudo }) {
    const p = data.players[id]; if (!p) return "Joueur introuvable.";
    const old = p.pseudo;
    if (!pseudo) { p.pseudo = null; adminLog(`Pseudo « ${old} » retiré (le joueur devra en choisir un autre)`); return; }
    const v = cleanPseudo(pseudo); if (!v) return "Pseudo invalide : 3 à 16 caractères, lettres, chiffres, espace, tiret, point ou tiret bas.";
    if (Object.entries(data.players).some(([k, o]) => k !== id && o.pseudo && o.pseudo.toLowerCase() === v.toLowerCase())) return "Ce pseudo est déjà pris.";
    p.pseudo = v; adminLog(`Pseudo « ${old || "aucun"} » → « ${v} »`);
  },
  remove({ id }) {
    const p = data.players[id]; if (!p) return "Joueur introuvable.";
    const name = p.pseudo || "anonyme";
    for (const day of Object.values(data.daily)) delete day[id];
    // on garde une fiche vide : sinon le téléphone du joueur renverrait son ancien record
    data.players[id] = { pseudo: null, best: 0, top: 1, rev: p.rev || 0 }; bumpRev(data.players[id]);
    adminLog(`${name} supprimé du classement`);
  },
  resetDaily() {
    const d = data.daily[today()] || {}, n = Object.keys(d).length;
    for (const id of Object.keys(d)) if (data.players[id]) bumpRev(data.players[id]);
    delete data.daily[today()]; adminLog(`Classement du défi du jour remis à zéro (${n} joueur${n > 1 ? "s" : ""})`);
  },
  resetAll({ confirm }) {
    if (confirm !== "RESET") return "Tape RESET pour confirmer.";
    const n = Object.keys(data.players).length;
    for (const p of Object.values(data.players)) { p.best = 0; p.top = 1; p.uni = 1; bumpRev(p); }
    data.daily = {}; adminLog(`Tout le classement remis à zéro (${n} joueurs, pseudos conservés)`);
  }
};
async function adminApi(req, res) {
  // l'en-tête X-Admin empêche un autre site de déclencher une action à ta place
  if (req.method !== "POST" || req.headers["x-admin"] !== "1") return send(res, 400, "{}", MIME[".json"]);
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return send(res, 413, "{}", MIME[".json"]); }
  let body; try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, "{}", MIME[".json"]); }
  const fn = Object.hasOwn(ADMIN_ACTIONS, body.action) && ADMIN_ACTIONS[body.action];
  if (!fn) return send(res, 400, JSON.stringify({ ok: false, error: "Action inconnue." }), MIME[".json"]);
  await ready;
  if (!loaded) return send(res, 503, JSON.stringify({ ok: false, error: "Le classement n'est pas encore chargé, réessaie dans une minute." }), MIME[".json"]);
  const err = fn(body);
  if (err) return send(res, 200, JSON.stringify({ ok: false, error: err }), MIME[".json"]);
  await saveNow();
  return send(res, 200, JSON.stringify({ ok: true, players: playersList(), log: data.log }), MIME[".json"], { "Cache-Control": "no-store" });
}

async function adminRoute(req, res, p) {
  if (!adminAuth(req, res)) return;
  if (p === "/admin/api") return adminApi(req, res);
  if (p === "/admin/players.json") { await ready; return send(res, 200, JSON.stringify({ players: playersList(), log: data.log }), MIME[".json"], { "Cache-Control": "no-store" }); }
  if (p === "/admin/sauvegarde.json") {
    await ready;
    return send(res, 200, JSON.stringify(data), MIME[".json"], { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="cosmos-sauvegarde-${today()}.json"` });
  }
  const st = statsSnapshot();
  if (p === "/admin/stats.json") return send(res, 200, JSON.stringify(st), MIME[".json"], { "Cache-Control": "no-store" });
  const js = await joskyStats();
  return send(res, 200, adminHtml(st, js), MIME[".html"], { "Cache-Control": "no-store" });
}
const fmtN = n => Number(n).toLocaleString("fr-FR");
const PHASES = { lobby: "Salle d'attente", initial_revealing: "Début de manche", playing: "Partie en cours", round_ended: "Fin de manche", game_over: "Partie terminée" };
const ADMIN_JS = fs.readFileSync(path.resolve(__dirname, "admin.js"), "utf8");
const ADMIN_PLAYERS_HTML = fs.readFileSync(path.resolve(__dirname, "admin-players.html"), "utf8");
function adminHtml(st, js) {
  const row = w => `<tr><td>${new Date(w.day + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })}</td><td>${w.players}</td><td>${w.newPlayers}</td><td>${w.records}</td></tr>`;
  const up = s => s > 3600 ? Math.floor(s / 3600) + " h" : Math.max(1, Math.floor(s / 60)) + " min";
  const jsOnline = js.state === "ok" ? js.online : 0, total = st.online + jsOnline;
  const live = (n, label, color) => `<div class="live"><span class="dot" style="background:${n ? color : "#555b7a"};box-shadow:${n ? "0 0 0 6px " + color + "33" : "none"}"></span><div><b>${n}</b><small>${label}</small></div></div>`;
  let joskyBlock;
  if (js.state === "ok") {
    const rooms = js.rooms.map(r => `<li><div class="top"><b>${esc(PHASES[r.phase] || r.phase)}</b><span>${r.idleMin ? "actif il y a " + r.idleMin + " min" : "actif à l'instant"}</span></div><div class="who">${r.players.map(pl => `<span class="p ${pl.connected ? "on" : ""}">${esc(pl.name)}</span>`).join("")}${r.bots ? `<span class="p bot">+ ${r.bots} bot${r.bots > 1 ? "s" : ""}</span>` : ""}</div></li>`).join("");
    joskyBlock = `${live(js.online, `joueur${js.online > 1 ? "s" : ""} connecté${js.online > 1 ? "s" : ""} à une partie`, "#5ff08f")}
<div class="grid"><div class="card"><small>Salons ouverts</small><b>${js.rooms.length}</b></div><div class="card"><small>Appareils connectés</small><b>${js.connections}</b></div></div>
${rooms ? `<ul>${rooms}</ul>` : '<p class="note">Aucun salon ouvert pour le moment.</p>'}
<p class="note">Serveur JoSky réveillé depuis ${up(js.uptime)}.</p>`;
  } else {
    const msg = {
      off: "Pour voir JoSky ici, ajoute dans le service Cosmos sur Render les variables <code>JOSKY_URL</code> (l'adresse de JoSky) et <code>JOSKY_ADMIN_PASSWORD</code> (son mot de passe ADMIN_PASSWORD).",
      asleep: "JoSky ne répond pas : il est sûrement en veille (personne n'y a joué depuis 15 min). Il se réveille, recharge la page dans une minute.",
      password: "JoSky refuse le mot de passe : vérifie que <code>JOSKY_ADMIN_PASSWORD</code> est identique à <code>ADMIN_PASSWORD</code> du service JoSky.",
      nopage: "La page de stats de JoSky n'existe pas encore : ajoute la variable <code>ADMIN_PASSWORD</code> dans le service JoSky.",
      error: "JoSky a répondu par une erreur (" + esc(js.status) + ")."
    }[js.state];
    joskyBlock = `<p class="note box">${msg}</p>`;
  }
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mes jeux · Stats</title><link rel="icon" href="/icon-192.png">
<style>
:root{--bg:#0b0d1a;--panel:#151a33;--ink:#e9ecff;--muted:#8a92c4;--flare:#ffb35c;--green:#5ff08f;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px max(16px,env(safe-area-inset-right)) 32px max(16px,env(safe-area-inset-left))}
main{max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
h1{margin:0;font-size:1.4rem}.sub{margin:2px 0 0;color:var(--muted);font-size:.85rem}
.hero{background:linear-gradient(135deg,#2a2266,#12402f);border-radius:18px;padding:16px 18px}
.hero b{font-size:2.6rem;line-height:1;font-variant-numeric:tabular-nums}.hero small{display:block;color:#c3c9f0}
.hero .split{display:flex;gap:16px;margin-top:10px;font-size:.9rem}.hero .split span{display:inline-flex;align-items:center;gap:6px}
.chip{width:9px;height:9px;border-radius:50%;display:inline-block}
.game{display:flex;align-items:center;gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid #ffffff14}
.game h2{margin:0;font-size:1.1rem;letter-spacing:0;text-transform:none;color:var(--ink)}
.game img,.game .ico{width:30px;height:30px;border-radius:8px}
.live{display:flex;align-items:center;gap:14px;background:var(--panel);border-radius:16px;padding:14px 16px}
.dot{width:14px;height:14px;border-radius:50%;flex:none}
.live b{font-size:2rem;line-height:1;font-variant-numeric:tabular-nums}.live small{display:block;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.card{background:var(--panel);border-radius:14px;padding:12px 14px}.card small{color:var(--muted);font-size:.78rem}.card b{display:block;font-size:1.35rem;font-variant-numeric:tabular-nums}
h3{margin:4px 0 0;font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600}
table{width:100%;border-collapse:collapse;background:var(--panel);border-radius:14px;overflow:hidden;font-variant-numeric:tabular-nums}
th,td{padding:9px 12px;text-align:right}th:first-child,td:first-child{text-align:left}th{font-size:.75rem;color:var(--muted);font-weight:600}tr+tr td{border-top:1px solid #ffffff10}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
li{background:var(--panel);border-radius:14px;padding:12px 14px}.top{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.top span{color:var(--muted);font-size:.8rem;white-space:nowrap}.who{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.p{font-size:.85rem;padding:3px 9px;border-radius:999px;background:#ffffff12;color:var(--muted)}.p.on{color:var(--ink);background:#5ff08f22;box-shadow:inset 0 0 0 1px #5ff08f66}
.p.on::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);margin-right:6px;vertical-align:1px}.p.bot{font-style:italic}
p.note{color:var(--muted);font-size:.82rem;margin:0}.box{background:var(--panel);border-radius:14px;padding:12px 14px}
code{font-size:.8rem;background:#ffffff14;padding:1px 5px;border-radius:5px;color:var(--ink)}
.tabs{display:flex;gap:4px;background:var(--panel);border-radius:12px;padding:4px;position:sticky;top:8px;z-index:5;box-shadow:0 6px 20px #0008}
.tabs button{flex:1;border:0;background:none;color:var(--muted);font:inherit;font-weight:600;padding:9px 8px;border-radius:9px;cursor:pointer}
.tabs button[aria-selected=true]{background:#2a3160;color:var(--ink)}
section{display:flex;flex-direction:column;gap:14px}section[hidden]{display:none}
input,.btn{font:inherit;color:var(--ink);border-radius:10px;border:1px solid #ffffff22;background:#0f1328;padding:9px 12px;min-height:40px}
input{width:100%}input:focus{outline:2px solid #6f7cff;outline-offset:1px}
.btn{cursor:pointer;background:#232a52;border-color:transparent;font-weight:600}
.btn:hover{background:#2e376a}.btn:disabled{opacity:.5;cursor:default}
.btn.primary{background:#ffb35c;color:#24160a}.btn.danger{background:#5a1f2c;color:#ffd5dc}.btn.danger:hover{background:#74283a}
.plist{display:flex;flex-direction:column;gap:8px}
.pl{background:var(--panel);border-radius:14px;overflow:hidden}
.pl>button{all:unset;box-sizing:border-box;width:100%;display:grid;grid-template-columns:2.4rem 1fr auto;gap:10px;align-items:center;padding:11px 14px;cursor:pointer}
.pl>button:focus-visible{outline:2px solid #6f7cff;outline-offset:-2px}
.rk{color:var(--muted);font-variant-numeric:tabular-nums;font-size:.85rem}
.nm{min-width:0}.nm b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nm small{color:var(--muted);font-size:.78rem}
.nm .anon{color:var(--muted);font-style:italic;font-weight:500}
.sc{font-variant-numeric:tabular-nums;font-weight:700;text-align:right}
.on-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-left:6px;vertical-align:2px}
.acts{display:none;border-top:1px solid #ffffff10;padding:12px 14px 14px;gap:10px;flex-direction:column}
.pl.open .acts{display:flex}.pl.open{box-shadow:inset 0 0 0 1px #6f7cff66}
.row{display:flex;gap:8px}.row input{flex:1;min-width:0}
.btns{display:flex;flex-wrap:wrap;gap:8px}.btns .btn{flex:1 1 calc(50% - 8px)}
.danger-zone{border:1px solid #74283a;border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px}
.danger-zone h3{color:#ff9fb0}
.log li{padding:9px 12px;font-size:.85rem}.log small{color:var(--muted);display:block;font-size:.75rem}
#toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);background:#e9ecff;color:#0b0d1a;padding:10px 16px;border-radius:12px;font-weight:600;max-width:calc(100% - 32px);box-shadow:0 8px 30px #000a;transition:opacity .2s;pointer-events:none}
#toast.err{background:#ff9fb0}#toast[hidden]{display:block;opacity:0}
</style></head><body><main>
<div><h1>Mes jeux · Stats</h1><p class="sub" id="sub">Mise à jour automatique toutes les 30 secondes</p></div>
<nav class="tabs" role="tablist"><button role="tab" data-tab="stats" aria-selected="true">Statistiques</button><button role="tab" data-tab="players" aria-selected="false">Joueurs Cosmos</button></nav>
<section id="tab-stats">
<div class="hero"><b>${total}</b><small>joueur${total > 1 ? "s" : ""} en ce moment, tous jeux confondus</small>
<div class="split"><span><i class="chip" style="background:var(--flare)"></i>Cosmos : ${st.online}</span><span><i class="chip" style="background:var(--green)"></i>JoSky : ${js.state === "ok" ? js.online : "–"}</span></div></div>

<div class="game"><img src="/icon-192.png" alt=""><h2>Cosmos</h2></div>
${live(st.online, `joueur${st.online > 1 ? "s" : ""} en train de jouer (3 dernières minutes)`, "#ffb35c")}
<h3>Aujourd'hui</h3>
<div class="grid">
<div class="card"><small>Joueurs actifs</small><b>${st.today.players}</b></div>
<div class="card"><small>Nouveaux joueurs</small><b>${st.today.newPlayers}</b></div>
<div class="card"><small>Ont battu leur record</small><b>${st.today.records}</b></div>
<div class="card"><small>Joueurs du défi du jour</small><b>${st.today.daily}</b></div>
</div>
<h3>7 derniers jours</h3>
<table><tr><th>Jour</th><th>Actifs</th><th>Nouveaux</th><th>Records</th></tr>${st.week.map(row).join("") || '<tr><td colspan="4">Pas encore de données</td></tr>'}</table>
<div class="grid">
<div class="card"><small>Joueurs enregistrés</small><b>${fmtN(st.total.players)}</b></div>
<div class="card"><small>Meilleur score</small><b>${fmtN(st.total.best)}</b></div>
</div>
<p class="note">Serveur Cosmos réveillé depuis ${up(st.uptime)}. La version FiveM n'est pas comptée.</p>

<div class="game"><span class="ico" style="background:linear-gradient(135deg,#1f7a52,#0b3024);display:grid;place-items:center;font-weight:800;color:#ffd36b">J</span><h2>JoSky</h2></div>
${joskyBlock}
</section>
<section id="tab-players" hidden>${ADMIN_PLAYERS_HTML}</section>
</main><script>${ADMIN_JS}</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);

  if (p === "/admin" || p.startsWith("/admin/")) return await adminRoute(req, res, p);

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
    await ready;
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

// On ouvre le serveur tout de suite (Render vérifie /healthz pendant le déploiement),
// puis on charge le classement ; les appels au classement attendent ce chargement.
server.listen(PORT, "0.0.0.0", () => console.log(`✅ Cosmos en ligne sur le port ${PORT}`));
const ready = load().then(cleanup).catch(e => console.error("Chargement du classement :", e.message));

async function shutdown(sig) {
  console.log(`${sig} reçu : sauvegarde du classement…`);
  await saveNow();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
