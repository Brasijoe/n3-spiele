CREATE TABLE IF NOT EXISTS plays (
  id TEXT PRIMARY KEY,
  game_id INTEGER,
  game TEXT NOT NULL,
  guest INTEGER NOT NULL DEFAULT 0,
  year INTEGER,
  date TEXT NOT NULL,
  players INTEGER NOT NULL,
  winner TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  duration INTEGER,
  first_play INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plays_created ON plays(created_at);

CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  game_id INTEGER,
  game TEXT NOT NULL,
  guest INTEGER NOT NULL DEFAULT 0,
  year INTEGER,
  date TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '',
  seats INTEGER NOT NULL,
  host TEXT NOT NULL,
  host_key_hash TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  attendees TEXT NOT NULL DEFAULT '{}',
  play_id TEXT,
  created_at TEXT NOT NULL,
  discord_channel TEXT,
  discord_msg TEXT
);
CREATE INDEX IF NOT EXISTS parties_date ON parties(date);

CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, ts INTEGER NOT NULL);
