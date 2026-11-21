CREATE TABLE IF NOT EXISTS subscribers (
  subscriber_no VARCHAR(64) PRIMARY KEY,
  display_name VARCHAR(128) NOT NULL DEFAULT 'Subscriber'
);

CREATE TABLE IF NOT EXISTS usage_records (
  id BIGSERIAL PRIMARY KEY,
  subscriber_no VARCHAR(64) NOT NULL REFERENCES subscribers(subscriber_no),
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year INTEGER NOT NULL,
  usage_type VARCHAR(16) NOT NULL CHECK (usage_type IN ('Phone', 'Internet')),
  amount NUMERIC(12, 3) NOT NULL CHECK (amount > 0)
);

CREATE TABLE IF NOT EXISTS payments (
  transaction_id VARCHAR(128) PRIMARY KEY,
  subscriber_no VARCHAR(64) NOT NULL REFERENCES subscribers(subscriber_no),
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year INTEGER NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usage_lookup_idx ON usage_records(subscriber_no, month, year);
CREATE INDEX IF NOT EXISTS payment_lookup_idx ON payments(subscriber_no, month, year);

INSERT INTO subscribers(subscriber_no, display_name)
VALUES ('1001', 'Demo Subscriber')
ON CONFLICT (subscriber_no) DO NOTHING;

INSERT INTO usage_records(subscriber_no, month, year, usage_type, amount)
VALUES
  ('1001', 4, 2025, 'Phone', 1200),
  ('1001', 4, 2025, 'Internet', 35000)
ON CONFLICT DO NOTHING;
