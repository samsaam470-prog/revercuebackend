CREATE TABLE IF NOT EXISTS wiki_cache (
  cache_key TEXT PRIMARY KEY,
  summary TEXT,
  image TEXT,
  cached_at TEXT NOT NULL
);
