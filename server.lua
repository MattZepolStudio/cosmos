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
            UNIQUE KEY uniq_pseudo (pseudo),
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
    -- Ancienne installation sans l'unicité des pseudos : on l'ajoute
    local idx = MySQL.scalar.await([[
        SELECT COUNT(*) FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = 'cosmos_scores' AND index_name = 'uniq_pseudo']])
    if idx == 0 then
        -- seuls les pseudos en double sont effacés (leurs joueurs devront en choisir un autre)
        MySQL.query.await([[
            UPDATE cosmos_scores s JOIN (
                SELECT pseudo FROM cosmos_scores WHERE pseudo IS NOT NULL GROUP BY pseudo HAVING COUNT(*) > 1
            ) d ON d.pseudo = s.pseudo SET s.pseudo = NULL]])
        MySQL.query.await("ALTER TABLE cosmos_scores ADD UNIQUE KEY uniq_pseudo (pseudo)")
    end
end)

local lastCall = {}

local function tooSoon(src, kind)
    local k = kind .. ":" .. src
    local now = os.time()
    if lastCall[k] and now - lastCall[k] < Config.SubmitCooldown then return true end
    lastCall[k] = now
    return false
end

local function clampInt(v, lo, hi)
    v = math.floor(tonumber(v) or 0)
    if v < lo then return lo end
    if v > hi then return hi end
    return v
end

local function validDay(d)
    return type(d) == "string" and d:match("^%d%d%d%d%-%d%d%-%d%d$") ~= nil
end

-- Pseudo saisi par le joueur : 3 à 16 caractères, lettres (accents compris), chiffres, espace, _ . -
local function cleanPseudo(p)
    if type(p) ~= "string" then return nil end
    p = p:gsub("%s+", " "):gsub("^ ", ""):gsub(" $", "")
    local len = utf8.len(p)
    if not len or len < Config.PseudoMinLength or len > Config.PseudoMaxLength then return nil end
    for _, c in utf8.codes(p) do
        local ok = (c >= 48 and c <= 57) or (c >= 65 and c <= 90) or (c >= 97 and c <= 122)
            or c == 32 or c == 95 or c == 46 or c == 45 or (c >= 0xC0 and c <= 0x24F)
        if not ok then return nil end
    end
    for _, word in ipairs(Config.BannedWords) do
        if p:lower():find(word:lower(), 1, true) then return nil end
    end
    return p
end

local function reply(src, id, result)
    TriggerClientEvent("cosmos:reply", src, id, result)
end

-- Nom affiché dans le classement : le pseudo du joueur.
-- Sans pseudo, le joueur n'apparaît pas (sauf si Config.RequirePseudo = false).
local nameExpr = Config.RequirePseudo and "s.pseudo" or "COALESCE(s.pseudo, s.name)"
local listFilter = Config.RequirePseudo and "AND s.pseudo IS NOT NULL" or ""

RegisterNetEvent("cosmos:getBoard", function(id, data)
    local src = source
    local key = Config.GetPlayerKey(src)
    local day = data and validDay(data.dayKey) and data.dayKey or os.date("%Y-%m-%d")

    local all = MySQL.query.await(([[
        SELECT s.player_key AS id, %s AS name, s.best, s.top FROM cosmos_scores s
        WHERE s.best > 0 %s ORDER BY s.best DESC LIMIT ?]]):format(nameExpr, listFilter),
        { Config.BoardSize }) or {}
    local daily = MySQL.query.await(([[
        SELECT d.player_key AS id, %s AS name, d.best, d.top, d.done
        FROM cosmos_daily d JOIN cosmos_scores s ON s.player_key = d.player_key
        WHERE d.day = ? %s ORDER BY d.best DESC LIMIT ?]]):format(nameExpr, listFilter),
        { day, Config.BoardSize }) or {}
    local me = MySQL.single.await("SELECT pseudo, best FROM cosmos_scores WHERE player_key = ?", { key })
    local myDay = MySQL.single.await("SELECT best, done FROM cosmos_daily WHERE player_key = ? AND day = ?", { key, day })

    -- On n'envoie jamais les licences des autres joueurs au téléphone : chaque ligne reçoit un id neutre
    for i, row in ipairs(all) do row.id = (row.id == key) and "me" or ("a" .. i) end
    for i, row in ipairs(daily) do row.id = (row.id == key) and "me" or ("d" .. i) end

    reply(src, id, {
        me = {
            id = "me",
            pseudo = me and me.pseudo or nil,
            best = me and me.best or 0,
            dayBest = myDay and myDay.best or 0,
            done = myDay and myDay.done or 0
        },
        requirePseudo = Config.RequirePseudo,
        all = all,
        daily = daily
    })
end)

RegisterNetEvent("cosmos:setPseudo", function(id, data)
    local src = source
    if tooSoon(src, "pseudo") then return reply(src, id, { ok = false, error = "cooldown" }) end
    local pseudo = cleanPseudo(type(data) == "table" and data.pseudo or nil)
    if not pseudo then return reply(src, id, { ok = false, error = "invalid" }) end

    local key = Config.GetPlayerKey(src)
    local owner = MySQL.scalar.await("SELECT player_key FROM cosmos_scores WHERE pseudo = ?", { pseudo })
    if owner and owner ~= key then return reply(src, id, { ok = false, error = "taken" }) end

    local name = (Config.GetDisplayName(src) or "Joueur"):sub(1, 40)
    local ok = pcall(function()
        MySQL.query.await([[
            INSERT INTO cosmos_scores (player_key, name, pseudo) VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE pseudo = VALUES(pseudo), name = VALUES(name)]],
            { key, name, pseudo })
    end)
    if not ok then return reply(src, id, { ok = false, error = "taken" }) end

    reply(src, id, { ok = true, pseudo = pseudo })
    TriggerClientEvent("cosmos:boardChanged", -1)
end)

RegisterNetEvent("cosmos:submitScore", function(id, data)
    local src = source
    if tooSoon(src, "score") then return reply(src, id, { ok = false, error = "cooldown" }) end
    if type(data) ~= "table" then return reply(src, id, { ok = false }) end

    local key = Config.GetPlayerKey(src)
    local name = (Config.GetDisplayName(src) or "Joueur"):sub(1, 40)
    local best = clampInt(data.best, 0, Config.MaxScore)
    local top = clampInt(data.top, 1, 12)

    -- Score général : on garde le meilleur. Le pseudo n'est jamais modifié ici.
    MySQL.query.await([[
        INSERT INTO cosmos_scores (player_key, name, best, top) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            top = IF(VALUES(best) > best, VALUES(top), top),
            best = GREATEST(best, VALUES(best))]],
        { key, name, best, top })

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
    lastCall["pseudo:" .. source] = nil
    lastCall["score:" .. source] = nil
end)
