-- Idempotent schema. Applied automatically by PostgresBillingStore.init() on every start,
-- so it also upgrades a database created by an earlier version of this project.
CREATE TABLE IF NOT EXISTS subscribers (
  subscriber_no VARCHAR(64) PRIMARY KEY,
  display_name  VARCHAR(128) NOT NULL DEFAULT 'Subscriber',
  password_hash TEXT
);
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE TABLE IF NOT EXISTS usage_records (
  id            BIGSERIAL PRIMARY KEY,
  subscriber_no VARCHAR(64) NOT NULL REFERENCES subscribers(subscriber_no),
  month         INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year          INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  usage_type    VARCHAR(16) NOT NULL CHECK (usage_type IN ('Phone', 'Internet')),
  amount        NUMERIC(12, 3) NOT NULL CHECK (amount > 0),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS bills (
  id                      BIGSERIAL PRIMARY KEY,
  subscriber_no           VARCHAR(64) NOT NULL REFERENCES subscribers(subscriber_no),
  month                   INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year                    INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  phone_minutes           NUMERIC(12, 3) NOT NULL,
  internet_mb             NUMERIC(12, 3) NOT NULL,
  phone_charge            NUMERIC(12, 2) NOT NULL,
  internet_base_charge    NUMERIC(12, 2) NOT NULL,
  internet_overage_charge NUMERIC(12, 2) NOT NULL,
  total                   NUMERIC(12, 2) NOT NULL,
  calculated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subscriber_no, month, year)
);

CREATE TABLE IF NOT EXISTS payments (
  transaction_id VARCHAR(128) PRIMARY KEY,
  subscriber_no  VARCHAR(64) NOT NULL REFERENCES subscribers(subscriber_no),
  month          INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year           INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  amount         NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usage_lookup_idx   ON usage_records(subscriber_no, year, month);
CREATE INDEX IF NOT EXISTS payment_lookup_idx ON payments(subscriber_no, year, month);
