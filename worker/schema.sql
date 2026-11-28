-- The D1 database behind clp.7he.dev: wrangler d1 execute clp-addons-usage --remote --file worker/schema.sql
-- Opt-in usage, one row per install ID per UTC day; deleted by /forget, pruned after 90 days.
CREATE TABLE IF NOT EXISTS reports (
  id TEXT NOT NULL,
  day TEXT NOT NULL,
  version TEXT NOT NULL,
  channel TEXT NOT NULL,
  arch TEXT NOT NULL,
  cloudpanel TEXT,
  addons TEXT NOT NULL,
  activity TEXT NOT NULL,
  country TEXT,
  asn INTEGER,
  network TEXT,
  PRIMARY KEY (id, day)
);
-- Which install ID reported from each daily address hash; emptied of past days by the cron.
CREATE TABLE IF NOT EXISTS reporters (
  day TEXT NOT NULL,
  hash TEXT NOT NULL,
  id TEXT NOT NULL,
  PRIMARY KEY (day, hash)
);
CREATE INDEX IF NOT EXISTS reporters_id ON reporters (id);
-- Daily totals rolled up by the cron, kept after Analytics Engine and the rows above expire.
CREATE TABLE IF NOT EXISTS daily (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  key TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (day, metric, key)
);
