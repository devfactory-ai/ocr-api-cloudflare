CREATE TABLE IF NOT EXISTS bulletins_valides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donnees_ia TEXT NOT NULL,
  statut_validation TEXT NOT NULL DEFAULT 'en_attente',
  erreurs_signalees TEXT DEFAULT '[]',
  commentaires_correction TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
