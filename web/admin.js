(() => {
  const $ = id => document.getElementById(id);
  const fmt = n => Number(n).toLocaleString("fr-FR");
  const esc = v => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ago = t => { if (!t) return "jamais"; const m = Math.floor((Date.now() - t) / 60000); if (m < 1) return "à l'instant"; if (m < 60) return "il y a " + m + " min"; const h = Math.floor(m / 60); if (h < 24) return "il y a " + h + " h"; const d = Math.floor(h / 24); return "il y a " + d + " jour" + (d > 1 ? "s" : ""); };

  /* ---------- onglets ---------- */
  const tabs = document.querySelectorAll(".tabs button");
  let current = "stats";
  function show(name) {
    current = name;
    tabs.forEach(b => b.setAttribute("aria-selected", b.dataset.tab === name));
    $("tab-stats").hidden = name !== "stats"; $("tab-players").hidden = name !== "players";
    $("sub").textContent = name === "stats" ? "Mise à jour automatique toutes les 30 secondes" : "Les modifications sont enregistrées tout de suite";
    try { history.replaceState(null, "", name === "players" ? "#joueurs" : location.pathname); } catch (e) {}
    if (name === "players" && !players) load();
    if (name === "stats") refreshStats();
  }
  // recharge seulement les chiffres de l'onglet Statistiques, sans recharger toute la page
  async function refreshStats() {
    try {
      const r = await fetch("/admin", { cache: "no-store" });
      if (!r.ok) return;
      const doc = new DOMParser().parseFromString(await r.text(), "text/html");
      const fresh = doc.getElementById("tab-stats");
      if (fresh) $("tab-stats").innerHTML = fresh.innerHTML;
    } catch (e) {}
  }
  tabs.forEach(b => b.addEventListener("click", () => show(b.dataset.tab)));
  // l'onglet Statistiques se recharge tout seul ; jamais pendant qu'on gère les joueurs
  setInterval(() => { if (current === "stats" && !document.hidden) refreshStats(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (current === "stats" && !document.hidden) refreshStats(); });

  /* ---------- joueurs ---------- */
  let players = null, log = [], openId = null, limit = 50, onlyFlag = false;
  const toast = (msg, err) => { const t = $("toast"); t.textContent = msg; t.className = err ? "err" : ""; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3200); };
  function take(r) { players = r.players; log = r.log || []; render(); }
  async function load() {
    try { const r = await fetch("/admin/players.json", { cache: "no-store" }); take(await r.json()); }
    catch (e) { $("plist").innerHTML = '<p class="note">Impossible de charger les joueurs. Recharge la page.</p>'; }
  }
  async function act(body, okMsg, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await fetch("/admin/api", { method: "POST", headers: { "Content-Type": "application/json", "X-Admin": "1" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) { toast(j.error || "Erreur du serveur.", true); return false; }
      take(j); toast(okMsg); return true;
    } catch (e) { toast("Le serveur ne répond pas.", true); return false; }
    finally { if (btn) btn.disabled = false; }
  }
  function row(p) {
    const name = (p.pseudo ? esc(p.pseudo) : '<span class="anon">sans pseudo</span>') + (p.flag ? '<span class="flagpill">À vérifier</span>' : "");
    const day = p.dayBest ? ` · défi ${fmt(p.dayBest)} (${p.done}/3)` : "";
    return `<div class="pl${openId === p.id ? " open" : ""}" data-id="${p.id}">
<button aria-expanded="${openId === p.id}"><span class="rk">${p.rank ? "#" + p.rank : "–"}</span>
<span class="nm"><b>${name}${p.online ? '<i class="on-dot" title="En train de jouer"></i>' : ""}</b><small>Univers ${p.uni}${day} · ${ago(p.seen)}</small></span>
<span class="sc">${fmt(p.best)}</span></button>
<div class="acts">
${p.flag ? `<div class="why"><b>Pourquoi ce score est mis de côté :</b><ul>${p.flag.map(r => `<li>${esc(r)}</li>`).join("")}</ul>${p.play ? `<p class="det">Dernière partie envoyée : <b>${fmt(p.play.m)} coups</b>, dont <b>${fmt(p.play.gh)} sans toucher</b> (${p.play.m ? Math.round(p.play.gh / p.play.m * 100) : 0} %) · régularité ${p.play.cv >= 1 ? "normale" : String(p.play.cv).replace(".", ",") + (p.play.cv < 0.12 ? " (machine)" : p.play.cv < 0.3 ? " (assez régulier)" : " (humain)")}${p.play.rate != null ? ` · ${String(p.play.rate).replace(".", ",")} coups/s` : ""} · masse ${fmt(p.play.s)}. Signalé ${ago(p.flagAt)}.</p>` : ""}
<p>Il est caché du classement. Valide-le si tu connais ce joueur, sinon remets-le à 0.</p><button class="btn primary" data-do="approve">Valider ce score</button></div>` : ""}
<form class="row" data-do="setScore"><input type="number" inputmode="numeric" min="0" step="1" value="${p.best}" aria-label="Nouveau score"><button class="btn primary">Changer le score</button></form>
<form class="row" data-do="rename"><input type="text" maxlength="16" value="${p.pseudo ? esc(p.pseudo) : ""}" placeholder="Nouveau pseudo" aria-label="Nouveau pseudo"><button class="btn">Renommer</button></form>
<div class="btns">
<button class="btn" data-do="resetScore">Remettre à 0</button>
${p.dayBest ? '<button class="btn" data-do="clearDaily">Effacer son défi du jour</button>' : ""}
${p.pseudo ? '<button class="btn" data-do="unname">Retirer le pseudo</button>' : ""}
<button class="btn danger" data-do="remove">Supprimer du classement</button>
</div></div></div>`;
  }
  function render() {
    const q = $("q").value.trim().toLowerCase();
    const flagged = players.filter(p => p.flag).length;
    if (!flagged) onlyFlag = false;
    const fb = $("flagbar"); fb.hidden = !flagged;
    fb.innerHTML = onlyFlag ? "Afficher tous les joueurs" : `<b>⚠ ${flagged} score${flagged > 1 ? "s" : ""} à vérifier</b><span>Joué${flagged > 1 ? "s" : ""} comme un robot, caché${flagged > 1 ? "s" : ""} du classement. Touche pour voir.</span>`;
    fb.classList.toggle("on", onlyFlag);
    const list = players.filter(p => (!onlyFlag || p.flag) && (!q || (p.pseudo || "").toLowerCase().includes(q)));
    $("nRanked").textContent = fmt(players.filter(p => p.rank).length);
    $("nDaily").textContent = fmt(players.filter(p => p.dayBest).length);
    $("plist").innerHTML = list.slice(0, limit).map(row).join("") || '<p class="note">Aucun joueur trouvé.</p>';
    $("more").hidden = list.length <= limit;
    $("log").innerHTML = log.length ? log.slice(0, 15).map(l => `<li>${esc(l.text)}<small>${new Date(l.at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small></li>`).join("") : '<li class="note">Aucune action pour le moment.</li>';
  }
  $("q").addEventListener("input", () => { limit = 50; render(); });
  $("flagbar").addEventListener("click", () => { onlyFlag = !onlyFlag; openId = null; render(); });
  $("more").addEventListener("click", () => { limit += 50; render(); });

  const plist = $("plist");
  plist.addEventListener("click", async e => {
    const card = e.target.closest(".pl"); if (!card) return;
    const id = card.dataset.id, p = players.find(x => x.id === id), who = p.pseudo || "ce joueur";
    if (e.target.closest(".pl > button")) { openId = openId === id ? null : id; render(); return; }
    const b = e.target.closest("button[data-do]"); if (!b) return;
    const d = b.dataset.do;
    if (d === "approve" && confirm(`Valider le score de ${who} ? Il réapparaît au classement. Ses prochaines parties resteront surveillées.`)) act({ action: "approve", id }, "Score validé", b);
    if (d === "resetScore" && confirm(`Remettre le score de ${who} à 0 ?`)) act({ action: "resetScore", id }, "Score remis à 0", b);
    if (d === "clearDaily" && confirm(`Effacer le score de ${who} au défi du jour ?`)) act({ action: "clearDaily", id }, "Défi du jour effacé", b);
    if (d === "unname" && confirm(`Retirer le pseudo « ${p.pseudo} » ? Le joueur disparaît du classement jusqu'à ce qu'il en choisisse un autre.`)) act({ action: "rename", id, pseudo: "" }, "Pseudo retiré", b);
    if (d === "remove" && confirm(`Supprimer ${who} du classement ? Son score et ses défis seront effacés.`)) { if (await act({ action: "remove", id }, "Joueur supprimé", b)) openId = null; }
  });
  plist.addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target, id = f.closest(".pl").dataset.id, v = f.querySelector("input").value.trim(), btn = f.querySelector("button");
    if (f.dataset.do === "setScore") {
      if (!/^\d+$/.test(v)) return toast("Entre un nombre entier.", true);
      act({ action: "setScore", id, best: Number(v) }, "Score modifié", btn);
    } else {
      if (!v) return toast("Entre un pseudo.", true);
      act({ action: "rename", id, pseudo: v }, "Pseudo modifié", btn);
    }
  });
  document.querySelectorAll("[data-global]").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.global === "resetDaily") {
      if (confirm("Vider le classement du défi du jour pour tout le monde ?")) act({ action: "resetDaily" }, "Défi du jour vidé", b);
    } else {
      const c = prompt("Tous les scores et tous les défis seront remis à zéro (les pseudos sont gardés).\nTape RESET pour confirmer :");
      if (c !== null) act({ action: "resetAll", confirm: c.trim().toUpperCase() }, "Classement remis à zéro", b);
    }
  }));

  if (location.hash === "#joueurs") show("players");
})();
