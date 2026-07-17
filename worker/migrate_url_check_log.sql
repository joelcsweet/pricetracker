CREATE TABLE IF NOT EXISTS url_check_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  price       REAL,
  method      TEXT,
  checked_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_url_check_log_product ON url_check_log(product_id, checked_at DESC);
