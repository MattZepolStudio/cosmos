Config = {}

-- Identifiant unique de l'appli dans lb-phone
Config.Identifier = "cosmos"

-- true : l'appli est installée d'office sur tous les téléphones
-- false : les joueurs l'installent depuis l'App Store du téléphone
Config.DefaultApp = false

-- Nombre de joueurs affichés dans chaque classement
Config.BoardSize = 30

-- Garde-fous contre les scores truqués (le score est calculé côté téléphone)
Config.MaxScore = 2000000      -- au-delà, le score est refusé
Config.SubmitCooldown = 2      -- secondes minimum entre deux envois d'un même joueur

-- Nom affiché dans le classement quand le joueur n'a pas choisi de pseudo.
-- Par défaut : nom FiveM du joueur. Remplace cette fonction pour utiliser
-- le nom du personnage RP (voir exemples QBCore / ESX dans le README).
Config.GetDisplayName = function(source)
    return GetPlayerName(source) or "Joueur"
end

-- Identifiant stable du joueur (une ligne de classement par identifiant).
-- Par défaut : la licence Rockstar. Pour un classement par personnage,
-- renvoie le citizenid (QBCore) ou l'identifier du personnage (ESX).
Config.GetPlayerKey = function(source)
    return GetPlayerIdentifierByType(source, "license") or ("src:" .. source)
end
