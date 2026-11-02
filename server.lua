-- Tables créées automatiquement au démarrage (voir aussi cosmos.sql)
MySQL.ready(function()
    MySQL.query.await([[
        CREATE TABLE IF NOT EXISTS cosmos_scores (
            player_key VARCHAR(80) NOT NULL PRIMARY KEY,
            name VARCHAR(40) NOT NULL,
            pseudo VARCHAR(16) NULL,
            best INT UNSIGNED NOT NULL DEFAULT 0,
            top TINYINT UNSIGNED NOT NULL DEFAULT 1,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_best (best)
        )
    ]])
    MySQL.query.await([[
        CREATE TABLE IF NOT EXISTS cosmos_daily (
            player_key VARCHAR(80) NOT NULL,
            day CHAR(10) NOT NULL,
            best INT UNSIGNED NOT NULL DEFAULT 0,
            top TINYINT UNSIGNED NOT NULL DEFAULT 1,
            done TINYINT UNSIGNED NOT NULL DEFAULT 0,
            PRIMARY KEY (player_key, day),
            INDEX idx_day_best (day, best)
        )
    ]])
end)

local lastSubmit = {}

local function clampInt(v, lo, hi)
    v = math.floor(tonumber(v) or 0)
    if v < lo then return lo end
    if v > hi then return hi end
    return v
end

local function validDay(d)
    return type(d) == "string" and d:match("^%d%d%d%d%-%d%d%-%d%d$") ~= nil
end

local function cleanPseudo(p)
    if type(p) ~= "string" then return nil end
    p = p:gsub("[%c<>]", ""):gsub("^%s+", ""):gsub("%s+$", "")
    if p == "" then return nil end
    return p:sub(1, 16)
end

local function reply(src, id, result)
    TriggerClientEvent("cosmos:reply", src, id, result)
end

RegisterNetEvent("cosmos:getBoard", function(id, data)
    local src = source
    local key = Config.GetPlayerKey(src)
    local day = data and validDay(data.dayKey) and data.dayKey or os.date("%Y-%m-%d")

    local all = MySQL.query.await(
        "SELECT player_key AS id, COALESCE(pseudo, name) AS name, best, top FROM cosmos_scores ORDER BY best DESC LIMIT ?",
        { Config.BoardSize }) or {}
    local daily = MySQL.query.await([[
        SELECT d.player_key AS id, COALESCE(s.pseudo, s.name, 'Joueur') AS name, d.best, d.top, d.done
        FROM cosmos_daily d LEFT JOIN cosmos_scores s ON s.player_key = d.player_key
        WHERE d.day = ? ORDER BY d.best DESC LIMIT ?]],
        { day, Config.BoardSize }) or {}
    local me = MySQL.single.await("SELECT pseudo FROM cosmos_scores WHERE player_key = ?", { key })

    -- On n'envoie jamais les licences des autres joueurs au téléphone : chaque ligne reçoit un id neutre
    for i, row in ipairs(all) do row.id = (row.id == key) and "me" or ("a" .. i) end
    for i, row in ipairs(daily) do row.id = (row.id == key) and "me" or ("d" .. i) end

    reply(src, id, {
        me = { id = "me", name = Config.GetDisplayName(src), pseudo = me and me.pseudo or nil },
        all = all,
        daily = daily
    })
end)

RegisterNetEvent("cosmos:submitScore", function(id, data)
    local src = source
    local now = os.time()
    if lastSubmit[src] and now - lastSubmit[src] < Config.SubmitCooldown then
        return reply(src, id, { ok = false, error = "cooldown" })
    end
    lastSubmit[src] = now
    if type(data) ~= "table" then return reply(src, id, { ok = false }) end

    local key = Config.GetPlayerKey(src)
    local name = (Config.GetDisplayName(src) or "Joueur"):sub(1, 40)
    local pseudo = cleanPseudo(data.pseudo)
    local best = clampInt(data.best, 0, Config.MaxScore)
    local top = clampInt(data.top, 1, 12)

    -- Score général : on garde le meilleur, le pseudo suit le dernier choix du joueur
    MySQL.query.await([[
        INSERT INTO cosmos_scores (player_key, name, pseudo, best, top) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            pseudo = VALUES(pseudo),
            top = IF(VALUES(best) > best, VALUES(top), top),
            best = GREATEST(best, VALUES(best))]],
        { key, name, pseudo, best, top })

    -- Défi du jour
    if validDay(data.dayKey) then
        local dayBest = clampInt(data.dayBest, 0, Config.MaxScore)
        if dayBest > 0 then
            MySQL.query.await([[
                INSERT INTO cosmos_daily (player_key, day, best, top, done) VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    top = IF(VALUES(best) > best, VALUES(top), top),
                    best = GREATEST(best, VALUES(best)),
                    done = GREATEST(done, VALUES(done))]],
                { key, data.dayKey, dayBest, clampInt(data.dayTop, 1, 12), clampInt(data.done, 0, 3) })
        end
    end

    reply(src, id, { ok = true })
    TriggerClientEvent("cosmos:boardChanged", -1)
end)

AddEventHandler("playerDropped", function()
    lastSubmit[source] = nil
end)
