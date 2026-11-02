local resource = GetCurrentResourceName()

-- Ajoute l'appli au téléphone (et la remet si lb-phone redémarre)
local function addApp()
    local ok, reason = exports["lb-phone"]:AddCustomApp({
        identifier = Config.Identifier,
        name = "Cosmos",
        description = "Fais grandir la poussière jusqu'au trou noir.",
        developer = "MattZepol Studio",
        defaultApp = Config.DefaultApp,
        size = 2048, -- kB, affiché dans l'App Store
        ui = resource .. "/ui/index.html",
        icon = "https://cfx-nui-" .. resource .. "/ui/icon.png",
        fixBlur = true
    })
    if not ok then
        print(("[cosmos] Impossible d'ajouter l'appli : %s"):format(tostring(reason)))
    end
end

CreateThread(function()
    while GetResourceState("lb-phone") ~= "started" do Wait(500) end
    addApp()
end)

AddEventHandler("onResourceStart", function(res)
    if res == "lb-phone" then addApp() end
end)

AddEventHandler("onResourceStop", function(res)
    if res == resource then
        pcall(function() exports["lb-phone"]:RemoveCustomApp(Config.Identifier) end)
    end
end)

-- Petit système requête/réponse vers le serveur
local pending, nextId = {}, 0

local function askServer(event, data)
    nextId = nextId + 1
    local id = nextId
    local p = promise.new()
    pending[id] = p
    TriggerServerEvent(event, id, data)
    SetTimeout(8000, function()
        if pending[id] then pending[id] = nil; p:resolve(nil) end
    end)
    return Citizen.Await(p)
end

RegisterNetEvent("cosmos:reply", function(id, result)
    local p = pending[id]
    if p then pending[id] = nil; p:resolve(result) end
end)

-- Appels venant de l'interface (fetchNui)
RegisterNUICallback("getBoard", function(data, cb)
    cb(askServer("cosmos:getBoard", data) or false)
end)

RegisterNUICallback("submitScore", function(data, cb)
    cb(askServer("cosmos:submitScore", data) or { ok = false })
end)

-- Le serveur prévient quand le classement change : l'appli se rafraîchit si elle est ouverte
RegisterNetEvent("cosmos:boardChanged", function()
    pcall(function()
        exports["lb-phone"]:SendCustomAppMessage(Config.Identifier, "cosmos:board", {})
    end)
end)
