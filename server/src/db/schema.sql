PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tracked_emails (
  email_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  sender_ip TEXT,
  sender_user_agent TEXT,
  open_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS open_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_address TEXT,
  user_agent TEXT,
  geo_country TEXT,
  geo_region TEXT,
  geo_city TEXT,
  latitude REAL,
  longitude REAL,
  device_type TEXT NOT NULL DEFAULT 'other' CHECK (device_type IN ('phone', 'computer', 'other')),
  is_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (is_duplicate IN (0, 1)),
  FOREIGN KEY (email_id) REFERENCES tracked_emails(email_id)
);

CREATE INDEX IF NOT EXISTS idx_tracked_emails_user_id ON tracked_emails(user_id);
CREATE INDEX IF NOT EXISTS idx_open_events_email_id_opened_at ON open_events(email_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_open_events_dedupe_lookup ON open_events(email_id, ip_address, user_agent, opened_at DESC);
