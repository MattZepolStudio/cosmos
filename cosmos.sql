-- Facultatif : la ressource crée ces tables toute seule au démarrage.
-- À importer à la main seulement si ton utilisateur MySQL n'a pas le droit CREATE.

CREATE TABLE IF NOT EXISTS cosmos_scores (
    player_key VARCHAR(80) NOT NULL PRIMARY KEY,
    name VARCHAR(40) NOT NULL,
    pseudo VARCHAR(16) NULL,
    best INT UNSIGNED NOT NULL DEFAULT 0,
    top TINYINT UNSIGNED NOT NULL DEFAULT 1,
    uni SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_pseudo (pseudo),
    INDEX idx_best (best)
);

CREATE TABLE IF NOT EXISTS cosmos_daily (
    player_key VARCHAR(80) NOT NULL,
    day CHAR(10) NOT NULL,
    best INT UNSIGNED NOT NULL DEFAULT 0,
    top TINYINT UNSIGNED NOT NULL DEFAULT 1,
    done TINYINT UNSIGNED NOT NULL DEFAULT 0,
    streak SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (player_key, day),
    INDEX idx_day_best (day, best)
);
