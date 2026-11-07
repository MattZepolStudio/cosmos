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
const hourNow = () => Number(new Date().toLocaleString("en-GB", { timeZone: process.env.COSMOS_TZ || "Europe/Paris", hour: "2-digit", hour12: false })) % 24;
function markActive(key) {
  presence.set(key, Date.now());
  const st = dayStats(), k = key.slice(0, 12);
  if (!st.players[k]) { st.players[k] = 1; pruneDays(); scheduleSave(); }
  // heures d'affluence : un bit par heure où ce joueur a été vu
  const bit = 2 ** hourNow(), hrs = st.hrs || (st.hrs = {});
  if (!((hrs[k] || 0) & bit)) { hrs[k] = (hrs[k] || 0) | bit; scheduleSave(); }
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
    flagged: players.filter(p => p.flag).length,
    total: { players: players.length, named: players.filter(p => p.pseudo).length, best: Math.max(0, ...players.map(p => p.best || 0)) },
    week: days.map(d => ({ day: d, players: Object.keys(data.stats[d].players).length, newPlayers: data.stats[d].newPlayers, records: Object.keys(data.stats[d].recordBy || {}).length })),
    uptime: Math.floor(process.uptime())
  };
}

/* Tout ce qu'affiche la page /admin, onglet Cosmos */
function cosmosData() {
  const day = today(), st = dayStats(day), players = Object.entries(data.players);
  const limit = Date.now() - ONLINE_MS;
  const onlineNames = [...presence].filter(([, t]) => t >= limit).map(([k]) => data.players[k]?.pseudo || null);
  const daily = data.daily[day] || {};
  const name = id => data.players[id]?.pseudo || null;
  const ranked = players.filter(([, p]) => p.pseudo && p.best > 0 && !p.flag).sort((a, b) => b[1].best - a[1].best);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const k = addDays(day, -i), sd = data.stats[k], dd = data.daily[k] || {};
    days.push({ day: k, players: sd ? Object.keys(sd.players).length : 0, newPlayers: sd?.newPlayers || 0, records: sd ? Object.keys(sd.recordBy || {}).length : 0,
      daily: Object.keys(dd).length, dailyDone: Object.values(dd).filter(d => d.done >= 3).length });
  }
  const hours = Array(24).fill(0);
  for (let i = 0; i < 7; i++) {
    const sd = data.stats[addDays(day, -i)];
    for (const mask of Object.values(sd?.hrs || {})) for (let h = 0; h < 24; h++) if (mask & 2 ** h) hours[h]++;
  }
  const unis = {};
  let blackHole = 0, mass = 0;
  for (const [, p] of players) {
    if (!(p.best > 0)) continue;
    const u = Math.min(p.uni || 1, 6);
    unis[u] = (unis[u] || 0) + 1;
    if ((p.top || 1) >= 12 || (p.uni || 1) > 1) blackHole++;
    mass += p.best;
  }
  const dEntries = Object.entries(daily);
  return {
    online: onlineNames.length,
    onlineNames: onlineNames.filter(Boolean),
    onlineAnon: onlineNames.filter(n => !n).length,
    today: { day, players: Object.keys(st.players).length, newPlayers: st.newPlayers, records: Object.keys(st.recordBy).length, pseudos: st.pseudos,
      daily: dEntries.length, dailyDone: dEntries.filter(([, d]) => d.done >= 3).length },
    days, hours,
    top: ranked.slice(0, 10).map(([id, p], i) => ({ rank: i + 1, pseudo: p.pseudo, best: p.best, uni: p.uni || 1, seen: p.updatedAt || 0 })),
    dailyTop: dEntries.filter(([id]) => name(id) && !data.players[id]?.flag).sort((a, b) => b[1].best - a[1].best).slice(0, 5)
      .map(([id, d]) => ({ pseudo: name(id), best: d.best, done: d.done || 0, streak: streakOf(id, day) })),
    unis, blackHole,
    totals: { players: players.length, named: players.filter(([, p]) => p.pseudo).length, ranked: ranked.length, best: ranked[0]?.[1].best || 0, bestBy: ranked[0]?.[1].pseudo || null, mass, flagged: players.filter(([, p]) => p.flag).length },
    server: { uptime: Math.floor(process.uptime()), storage: UPSTASH_URL ? "Upstash" : "fichier", loaded }
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
  const named = Object.entries(data.players).filter(([, p]) => p.pseudo && !p.flag);
  const ranked = named.filter(([, p]) => p.best > 0).sort((a, b) => b[1].best - a[1].best);
  const myRank = ranked.findIndex(([id]) => id === key) + 1 || null;
  const all = ranked
    .slice(0, CONFIG.boardSize)
    .map(([id, p], i) => ({ id: id === key ? "me" : "a" + (i + 1), name: p.pseudo, best: p.best, top: p.top, uni: p.uni || 1 }));
  const dayRows = data.daily[day] || {};
  const dayRanked = Object.entries(dayRows)
    .filter(([id]) => data.players[id] && data.players[id].pseudo && !data.players[id].flag)
    .sort((a, b) => b[1].best - a[1].best);
  const myDayRank = dayRanked.findIndex(([id]) => id === key) + 1 || null;
  const daily = dayRanked
    .slice(0, CONFIG.boardSize)
    .map(([id, d], i) => ({ id: id === key ? "me" : "d" + (i + 1), name: data.players[id].pseudo, best: d.best, top: d.top, done: d.done, streak: d.done >= 3 ? d.streak || 1 : 0 }));
  const myDay = dayRows[key];
  return {
    me: { id: "me", pseudo: me?.pseudo || null, best: me?.best || 0, dayBest: myDay?.best || 0, done: myDay?.done || 0, rank: myRank, dayRank: myDayRank, streak: streakOf(key, day), rev: me?.rev || 0, flagged: !!me?.flag },
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
  checkBot(key, p, body.g);
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

/* ---------- détection des robots ----------
   Le jeu envoie avec chaque score le rythme de la partie en cours. Un score suspect n'est pas
   supprimé : il est caché du classement et signalé dans /admin, où tu décides. */
const BOT = {
  maxRate: 4.5,          // coups par seconde, tenus sur au moins 300 coups
  maxGhost: 0.2,         // part des coups joués sans toucher l'écran ni le clavier
  minCv: 0.12,           // régularité : un humain varie beaucoup plus que ça entre deux coups
  maxPerMove: 250,       // points par coup : au-delà, le score est impossible
  dataFrom: "2026-11-08" // après cette date, un score envoyé sans rythme de partie est suspect
};
const BOT_REASONS = {
  speed: "joue plus de 4,5 coups par seconde en continu",
  ghost: "coups joués sans toucher l'écran ni le clavier",
  regular: "rythme trop régulier, comme une machine",
  impossible: "trop de points pour le nombre de coups joués",
  nodata: "jeu modifié : il n'envoie pas le rythme de la partie"
};
const gameTrack = new Map(); // joueur -> { id, t0, m0 } (heure du serveur)
function checkBot(key, p, g) {
  if (p.trusted) return;
  // partie déjà validée à la main dans /admin : on ne la signale plus, les suivantes restent surveillées
  if (g && typeof g === "object" && p.okGame && String(g.id || "").slice(0, 16) === p.okGame) return;
  const reasons = [];
  if (!g || typeof g !== "object") { if (today() >= BOT.dataFrom && Number(p.best) > 0) reasons.push("nodata"); }
  else {
    const m = clampInt(g.m, 0, 1e7), gh = clampInt(g.gh, 0, 1e7), n = clampInt(g.n, 0, 1000), sc = clampInt(g.s, 0, CONFIG.maxScore);
    const cv = Number(g.cv), id = String(g.id || "").slice(0, 16);
    let tr = gameTrack.get(key);
    if (!tr || tr.id !== id || m < tr.m0) { tr = { id, t0: Date.now(), m0: m }; gameTrack.set(key, tr); if (gameTrack.size > 5000) gameTrack.clear(); }
    const dm = m - tr.m0, secs = (Date.now() - tr.t0) / 1000;
    if (dm >= 300 && dm / Math.max(secs, 1) > BOT.maxRate) reasons.push("speed");
    if (m >= 60 && gh / m > BOT.maxGhost) reasons.push("ghost");
    if (n >= 60 && Number.isFinite(cv) && cv < BOT.minCv) reasons.push("regular");
    if (m >= 50 && sc / m > BOT.maxPerMove) reasons.push("impossible");
  }
  if (g && typeof g === "object") {
    const tr = gameTrack.get(key), secs = tr ? (Date.now() - tr.t0) / 1000 : 0;
    p.lastPlay = { id: String(g.id || "").slice(0, 16), m: clampInt(g.m, 0, 1e7), gh: clampInt(g.gh, 0, 1e7), cv: Number(g.cv) || 0, s: clampInt(g.s, 0, CONFIG.maxScore), rate: tr && secs > 30 ? Math.round((clampInt(g.m, 0, 1e7) - tr.m0) / secs * 10) / 10 : null, at: Date.now() };
  }
  if (!reasons.length) return;
  const f = p.flag || (p.flag = { at: Date.now(), reasons: [] });
  for (const r of reasons) if (!f.reasons.includes(r)) f.reasons.push(r);
  f.last = Date.now();
  if (!f.logged) { f.logged = 1; adminLog(`⚠ ${p.pseudo || "Joueur sans pseudo"} mis de côté : ${f.reasons.map(r => BOT_REASONS[r]).join(", ")}`); }
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
// adresse tolérante : « josky-xxxx.onrender.com », avec ou sans https://, avec ou sans / ou /admin à la fin
const JOSKY_URL = (() => {
  let u = (process.env.JOSKY_URL || "").trim().replace(/^["']|["']$/g, "");
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { const x = new URL(u); return x.origin; } catch { return u; }
})();
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
  } catch (e) {
    // on distingue la veille (délai dépassé) d'une adresse fausse, pour savoir quoi corriger
    const code = e?.cause?.code || e?.code || "";
    if (e?.name === "TimeoutError" || e?.name === "AbortError") value = { state: "asleep" };
    else if (code === "ENOTFOUND" || code === "EAI_AGAIN") value = { state: "badurl", detail: "adresse introuvable" };
    else if (e instanceof TypeError && /URL/i.test(e.message)) value = { state: "badurl", detail: "adresse mal écrite" };
    else value = { state: "error", status: code || e?.message || "connexion impossible" };
  }
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
  const ranked = Object.entries(data.players).filter(([, p]) => p.pseudo && p.best > 0 && !p.flag).sort((a, b) => b[1].best - a[1].best);
  const rank = new Map(ranked.map(([id], i) => [id, i + 1]));
  return Object.entries(data.players)
    .filter(([, p]) => p.pseudo || p.best > 0)
    .map(([id, p]) => ({ id, play: p.lastPlay || null, flagAt: p.flag?.at || null, flag: p.flag ? p.flag.reasons.map(r => BOT_REASONS[r] || r) : null, trusted: !!p.trusted, pseudo: p.pseudo || null, best: p.best || 0, uni: p.uni || 1, rank: rank.get(id) || null, seen: p.updatedAt || 0, online: (presence.get(id) || 0) >= Date.now() - ONLINE_MS, dayBest: day[id]?.best || 0, done: day[id]?.done || 0, streak: streakOf(id, today()) }))
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
  resetScore({ id }) { const p = data.players[id]; if (p) delete p.flag; return ADMIN_ACTIONS.setScore({ id, best: 0 }); },
  approve({ id }) {
    const p = data.players[id]; if (!p) return "Joueur introuvable.";
    delete p.flag; if (p.lastPlay?.id) p.okGame = p.lastPlay.id;
    adminLog(`Score de ${p.pseudo || "anonyme"} validé (${fmtN(p.best || 0)}) : ses prochaines parties restent surveillées`);
  },
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
  if (p === "/admin/stats.json") return send(res, 200, JSON.stringify(statsSnapshot()), MIME[".json"], { "Cache-Control": "no-store" });
  if (p === "/admin/data.json") {
    await ready;
    const josky = await joskyStats();
    return send(res, 200, JSON.stringify({ at: Date.now(), cosmos: cosmosData(), josky: { ...josky, url: JOSKY_URL } }), MIME[".json"], { "Cache-Control": "no-store" });
  }
  return send(res, 200, ADMIN_PAGE, MIME[".html"], { "Cache-Control": "no-store" });
}
const fmtN = n => Number(n).toLocaleString("fr-FR");
// Page /admin : un seul fichier (styles et script compris) qui lit /admin/data.json
const ADMIN_PAGE = fs.readFileSync(path.resolve(__dirname, "admin-page.html"), "utf8");

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
    try { return send(res, 200, await indexHtml(), MIME[".html"], { "Cache-Control": "no-cache", "X-Cosmos-App": "1" }); }
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
