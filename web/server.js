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
  maxScore: 2_000_000,
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

let data = { players: {}, daily: {} };

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
      data = { players: d.players || {}, daily: d.daily || {} };
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
}

/* ---------- règles du classement ---------- */
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number(v) || 0)));
const validDay = d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const today = () => new Date().toISOString().slice(0, 10);

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
  const all = named
    .filter(([, p]) => p.best > 0)
    .sort((a, b) => b[1].best - a[1].best)
    .slice(0, CONFIG.boardSize)
    .map(([id, p], i) => ({ id: id === key ? "me" : "a" + (i + 1), name: p.pseudo, best: p.best, top: p.top }));
  const dayRows = data.daily[day] || {};
  const daily = Object.entries(dayRows)
    .filter(([id]) => data.players[id] && data.players[id].pseudo)
    .sort((a, b) => b[1].best - a[1].best)
    .slice(0, CONFIG.boardSize)
    .map(([id, d], i) => ({ id: id === key ? "me" : "d" + (i + 1), name: data.players[id].pseudo, best: d.best, top: d.top, done: d.done }));
  const myDay = dayRows[key];
  return {
    me: { id: "me", pseudo: me?.pseudo || null, best: me?.best || 0, dayBest: myDay?.best || 0, done: myDay?.done || 0 },
    requirePseudo: true,
    all,
    daily
  };
}

function setPseudo(key, body) {
  const pseudo = cleanPseudo(body.pseudo);
  if (!pseudo) return { ok: false, error: "invalid" };
  const low = pseudo.toLowerCase();
  const owner = Object.entries(data.players).find(([id, p]) => id !== key && p.pseudo && p.pseudo.toLowerCase() === low);
  if (owner) return { ok: false, error: "taken" };
  if (tooSoon(key, "pseudo")) return { ok: false, error: "cooldown" };
  const p = data.players[key] || (data.players[key] = { best: 0, top: 1 });
  p.pseudo = pseudo;
  p.updatedAt = Date.now();
  scheduleSave();
  return { ok: true, pseudo };
}

function submitScore(key, body) {
  if (tooSoon(key, "score")) return { ok: false, error: "cooldown" };
  const p = data.players[key] || (data.players[key] = { pseudo: null, best: 0, top: 1 });
  const best = clampInt(body.best, 0, CONFIG.maxScore);
  if (best > p.best) { p.best = best; p.top = clampInt(body.top, 1, 12); }
  p.updatedAt = Date.now();
  if (validDay(body.dayKey)) {
    const dayBest = clampInt(body.dayBest, 0, CONFIG.maxScore);
    if (dayBest > 0) {
      const day = data.daily[body.dayKey] || (data.daily[body.dayKey] = {});
      const d = day[key] || (day[key] = { best: 0, top: 1, done: 0 });
      if (dayBest > d.best) { d.best = dayBest; d.top = clampInt(body.dayTop, 1, 12); }
      d.done = Math.max(d.done, clampInt(body.done, 0, 3));
      pruneDays();
    }
  }
  scheduleSave();
  return { ok: true };
}

const API = { getBoard, setPseudo, submitScore };

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);

  if (p === "/healthz") return send(res, 200, JSON.stringify({ status: "healthy", uptime: Math.floor(process.uptime()) }), MIME[".json"]);

  if (p.startsWith("/api/nui/")) {
    const fn = API[p.slice(9)];
    if (!fn || req.method !== "POST") return send(res, 404, "{}", MIME[".json"]);
    const key = playerKey(req);
    if (!key) return send(res, 400, JSON.stringify({ ok: false, error: "player" }), MIME[".json"]);
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return send(res, 413, "{}", MIME[".json"]); }
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, "{}", MIME[".json"]); }
    if (!body || typeof body !== "object") body = {};
    return send(res, 200, JSON.stringify(fn(key, body)), MIME[".json"], { "Cache-Control": "no-store" });
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
server.listen(PORT, "0.0.0.0", () => console.log(`✅ Cosmos en ligne sur le port ${PORT}`));

async function shutdown(sig) {
  console.log(`${sig} reçu : sauvegarde du classement…`);
  await saveNow();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
