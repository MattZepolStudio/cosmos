/* Pont web : le jeu (ui/index.html) parle au serveur FiveM avec fetchNui.
   Ici, fetchNui envoie les mêmes demandes à l'API du serveur Render. */
(function () {
  function newToken() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.from(a, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  // Identifiant secret du joueur sur ce téléphone (le serveur n'en garde qu'une empreinte)
  var token = null;
  try { token = localStorage.getItem("cosmos-player"); } catch (e) {}
  if (!token) {
    token = newToken();
    try { localStorage.setItem("cosmos-player", token); } catch (e) {}
  }

  window.fetchNui = function (name, data) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 60000); // le serveur gratuit peut mettre ~50 s à se réveiller
    return fetch("/api/nui/" + name, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cosmos-Player": token },
      body: JSON.stringify(data || {}),
      signal: ctrl.signal
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  };

  // Rafraîchit le classement quand on revient dans l'appli
  var handlers = {};
  window.onNuiEvent = function (name, fn) { handlers[name] = fn; };
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && handlers["cosmos:board"]) handlers["cosmos:board"]();
  });

  // Appli installable et jouable hors ligne
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); });
  }
  document.documentElement.classList.add("web");
})();
