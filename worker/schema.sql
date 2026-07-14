-- Run once to initialise the D1 database:
--   wrangler d1 execute pricetracker-db --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,          -- UUID v4
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  target_price    REAL NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'AUD',
  last_price      REAL,
  last_checked_at TEXT,                      -- ISO 8601
  status          TEXT NOT NULL DEFAULT 'pending',
  -- status values: pending | ok | target_hit | needs_attention | error
  extraction_method TEXT,                    -- which cascade step succeeded
  active          INTEGER NOT NULL DEFAULT 1, -- 0 = paused, skipped by checks
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price       REAL NOT NULL,
  checked_at  TEXT NOT NULL                 -- ISO 8601
);

CREATE TABLE IF NOT EXISTS alerts_sent (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price       REAL NOT NULL,
  sent_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history(product_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_sent_product   ON alerts_sent(product_id, sent_at DESC);
