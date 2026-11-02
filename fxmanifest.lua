fx_version "cerulean"
game "gta5"
lua54 "yes"

name "cosmos"
description "Cosmos : jeu de fusion spatial pour lb-phone (de la poussière au trou noir)"
author "MattZepol Studio"
version "1.0.0"

dependencies {
    "lb-phone",
    "oxmysql"
}

shared_script "config.lua"

client_script "client.lua"

server_scripts {
    "@oxmysql/lib/MySQL.lua",
    "server.lua"
}

files {
    "ui/index.html",
    "ui/icon.png",
    "ui/img/*.png"
}
