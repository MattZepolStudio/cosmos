# Cosmos pour lb-phone

Jeu de fusion spatial : fais grandir la poussière jusqu'au trou noir.
Partie libre, défi du jour avec missions, catalogue des astres, classement général et classement du jour pour tout le serveur.

## Installation

1. Clone ce dépôt dans tes ressources (le dossier doit s'appeler `cosmos`) :
   ```
   git clone https://github.com/MattZepolStudio/cosmos.git
   ```
2. Ajoute dans `server.cfg`, **après** `oxmysql` et `lb-phone` :
   ```
   ensure cosmos
   ```
3. Redémarre. Les tables `cosmos_scores` et `cosmos_daily` sont créées automatiquement
   (sinon importe `cosmos.sql`).
4. L'appli apparaît dans l'App Store du téléphone (ou directement sur l'écran
   d'accueil si `Config.DefaultApp = true`).

Dépendances : `lb-phone`, `oxmysql`.

## Réglages (`config.lua`)

- `Config.DefaultApp` : appli installée d'office ou non.
- `Config.BoardSize` : nombre de joueurs dans chaque classement.
- `Config.MaxScore`, `Config.SubmitCooldown` : garde-fous contre la triche.
- `Config.GetPlayerKey` : une ligne de classement par licence (par défaut) ou par personnage.
- `Config.GetDisplayName` : nom affiché si le joueur n'a pas choisi de pseudo.

### Utiliser le nom du personnage RP

QBCore :
```lua
local QBCore = exports["qb-core"]:GetCoreObject()
Config.GetPlayerKey = function(src)
    local p = QBCore.Functions.GetPlayer(src)
    return p and p.PlayerData.citizenid or ("src:" .. src)
end
Config.GetDisplayName = function(src)
    local p = QBCore.Functions.GetPlayer(src)
    if not p then return "Joueur" end
    local c = p.PlayerData.charinfo
    return c.firstname .. " " .. c.lastname
end
```

ESX :
```lua
local ESX = exports["es_extended"]:getSharedObject()
Config.GetPlayerKey = function(src)
    local x = ESX.GetPlayerFromId(src)
    return x and x.identifier or ("src:" .. src)
end
Config.GetDisplayName = function(src)
    local x = ESX.GetPlayerFromId(src)
    return x and x.getName() or "Joueur"
end
```
(Ces fonctions ne sont appelées que côté serveur.)

## Ce qui a été optimisé pour le téléphone en jeu

- Les astres sont des images PNG pré-rendues (`ui/img`) : aucune génération au lancement.
- Particules plafonnées et toile d'effets en résolution 1x pour préserver les FPS de GTA.
- L'animation du logo tourne à 30 images/s et se met en pause après 20 s sans interaction.
- Les effets s'arrêtent d'eux-mêmes quand il n'y a plus rien à animer.
- Les licences des autres joueurs ne sont jamais envoyées au téléphone.

## À vérifier sur ton serveur

- **Signature des exports lb-phone** : `AddCustomApp`, `RemoveCustomApp` et
  `SendCustomAppMessage(identifier, action, data)` sont écrits d'après la doc
  lb-phone (Custom Apps). Si ta version diffère, ajuste `client.lua`.
- **Marge du haut** : l'interface laisse 46 px pour la barre d'état du téléphone
  (`.app{padding-block:46px 26px}` dans `ui/index.html`). Ajuste si ça chevauche.
- **Polices** : elles se chargent depuis Google Fonts. Sans internet, le jeu passe
  sur une police système. Pour les embarquer, ajoute les fichiers `.woff2`
  dans `ui/fonts` et remplace le `<link>` par des `@font-face`.
- **Triche** : le score est calculé dans le téléphone. Les garde-fous serveur
  limitent les abus évidents, pas un joueur déterminé.

## Tester dans un navigateur

Ouvre `ui/index.html` via un petit serveur local (par ex. `npx serve ui`).
Hors du téléphone, un mode démo garde le classement dans le navigateur.
