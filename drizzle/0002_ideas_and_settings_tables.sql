DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  hook TEXT NOT NULL,
  type TEXT NOT NULL,
  crazy_score REAL NOT NULL,
  why_shy_away TEXT NOT NULL DEFAULT '',
  market_signal TEXT NOT NULL DEFAULT '',
  upside_case TEXT NOT NULL DEFAULT '',
  why_for_you TEXT NOT NULL DEFAULT '',
  first_move TEXT NOT NULL DEFAULT '',
  seven_day_test TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new',
  batch_label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
