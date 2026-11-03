Config = {}

-- Identifiant unique de l'appli dans lb-phone
Config.Identifier = "cosmos"

-- true : l'appli est installée d'office sur tous les téléphones
-- false : les joueurs l'installent depuis l'App Store du téléphone
Config.DefaultApp = false

-- Nombre de joueurs affichés dans chaque classement
Config.BoardSize = 30

-- Pseudo du classement : c'est le joueur qui le choisit dans l'appli (unique sur le serveur).
-- true : seuls les joueurs qui ont choisi un pseudo apparaissent dans le classement
-- false : sans pseudo, le joueur apparaît avec le nom donné par Config.GetDisplayName
Config.RequirePseudo = true
Config.PseudoMinLength = 3
Config.PseudoMaxLength = 16
-- Mots refusés dans les pseudos (insensible à la casse)
Config.BannedWords = { "admin", "staff", "modo" }

-- Garde-fous contre les scores truqués (le score est calculé côté téléphone)
Config.MaxScore = 50000000     -- au-delà, le score est refusé (les univers multiplient les points)
Config.SubmitCooldown = 2      -- secondes minimum entre deux envois d'un même joueur

-- Nom enregistré avec le score (utile pour les admins en base de données).
-- Il n'est affiché dans le classement que si Config.RequirePseudo = false.
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
