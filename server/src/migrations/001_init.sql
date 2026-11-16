-- Borrowings System: initial schema. Money is NUMERIC, never float.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','manager','officer','auditor')),
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  totp_secret_enc text,
  totp_enabled boolean NOT NULL DEFAULT false,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  active boolean NOT NULL DEFAULT true,
  phone text,
  notify_email boolean NOT NULL DEFAULT true,
  notify_sms boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

CREATE TABLE banks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  coverage_ratio numeric(7,2) NOT NULL CHECK (coverage_ratio > 0),
  top_up_ratio numeric(7,2) CHECK (top_up_ratio > 0),
  margin_call_ratio numeric(7,2) CHECK (margin_call_ratio > 0),
  eligibility_mode text NOT NULL DEFAULT 'all' CHECK (eligibility_mode IN ('all','list')),
  contact_name text,
  contact_email text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (top_up_ratio IS NULL OR top_up_ratio <= coverage_ratio),
  CHECK (margin_call_ratio IS NULL OR margin_call_ratio <= COALESCE(top_up_ratio, coverage_ratio))
);

CREATE TABLE securities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL UNIQUE,
  name text NOT NULL,
  exchange text NOT NULL DEFAULT 'TADAWUL',
  currency text NOT NULL DEFAULT 'SAR',
  last_price numeric(18,4) CHECK (last_price > 0),
  last_price_at timestamptz,
  last_price_source text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_eligible_securities (
  bank_id uuid NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  security_id uuid NOT NULL REFERENCES securities(id),
  haircut_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (haircut_pct >= 0 AND haircut_pct < 100),
  PRIMARY KEY (bank_id, security_id)
);
CREATE INDEX bank_eligible_security_idx ON bank_eligible_securities(security_id);

-- Price history is append-only by convention; retained for audit and reporting.
CREATE TABLE prices (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  security_id uuid NOT NULL REFERENCES securities(id),
  price numeric(18,4) NOT NULL CHECK (price > 0),
  as_of timestamptz NOT NULL,
  source text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prices_security_asof_idx ON prices(security_id, as_of DESC);

CREATE TABLE loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_id uuid NOT NULL REFERENCES banks(id),
  loan_no text NOT NULL,
  facility_type text NOT NULL DEFAULT 'Murabaha',
  currency text NOT NULL DEFAULT 'SAR',
  limit_amount numeric(20,2) NOT NULL CHECK (limit_amount >= 0),
  used_amount numeric(20,2) NOT NULL DEFAULT 0 CHECK (used_amount >= 0),
  start_date date NOT NULL,
  maturity_date date NOT NULL,
  review_date date,
  renewal_date date,
  rate_type text NOT NULL DEFAULT 'floating' CHECK (rate_type IN ('fixed','floating')),
  rate_pct numeric(7,4) CHECK (rate_pct >= 0),
  benchmark text,
  margin_pct numeric(7,4),
  coverage_ratio numeric(7,2) CHECK (coverage_ratio > 0),
  top_up_ratio numeric(7,2) CHECK (top_up_ratio > 0),
  margin_call_ratio numeric(7,2) CHECK (margin_call_ratio > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_id, loan_no),
  UNIQUE (id, bank_id),
  CHECK (used_amount <= limit_amount),
  CHECK (maturity_date >= start_date)
);

CREATE TABLE loan_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id uuid NOT NULL REFERENCES loans(id),
  type text NOT NULL CHECK (type IN ('drawdown','repayment')),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  value_date date NOT NULL,
  reference text,
  notes text,
  balance_after numeric(20,2) NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loan_tx_loan_idx ON loan_transactions(loan_id, value_date DESC);

CREATE TABLE finance_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id uuid NOT NULL REFERENCES loans(id),
  charge_type text NOT NULL CHECK (charge_type IN ('profit','fee','commission','other')),
  due_date date NOT NULL,
  amount numeric(20,2) NOT NULL CHECK (amount >= 0),
  status text NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','cancelled')),
  paid_date date,
  reference text,
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'paid') = (paid_date IS NOT NULL))
);
CREATE INDEX finance_charges_due_idx ON finance_charges(status, due_date);
CREATE INDEX finance_charges_loan_idx ON finance_charges(loan_id);

-- A portfolio may sit at a bank (bank_id) and be pledged to one of that bank's loans (loan_id).
-- The composite FK guarantees a portfolio can only be pledged to a loan of its own bank.
CREATE TABLE portfolios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  bank_id uuid REFERENCES banks(id),
  loan_id uuid,
  custody_account text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (loan_id, bank_id) REFERENCES loans(id, bank_id),
  CHECK (loan_id IS NULL OR bank_id IS NOT NULL)
);
CREATE INDEX portfolios_loan_idx ON portfolios(loan_id);
CREATE INDEX portfolios_bank_idx ON portfolios(bank_id);

CREATE TABLE holdings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES portfolios(id),
  security_id uuid NOT NULL REFERENCES securities(id),
  quantity numeric(20,4) NOT NULL CHECK (quantity > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, security_id)
);
CREATE INDEX holdings_security_idx ON holdings(security_id);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id uuid NOT NULL REFERENCES loans(id),
  title text NOT NULL,
  category text NOT NULL DEFAULT 'agreement',
  expiry_date date,
  current_version int NOT NULL DEFAULT 0,
  archived boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_loan_idx ON documents(loan_id);

CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id),
  version_no int NOT NULL,
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  note text,
  uploaded_by uuid REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no)
);

-- Maker-checker: a different user must decide.
CREATE TABLE change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command text NOT NULL,
  payload jsonb NOT NULL,
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE INDEX change_requests_status_idx ON change_requests(status, requested_at DESC);

-- Tamper-evident audit trail: hash-chained, and UPDATE/DELETE/TRUNCATE are rejected.
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,
  actor_id uuid,
  actor_label text NOT NULL,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  before jsonb,
  after jsonb,
  meta jsonb,
  ip text,
  prev_hash text NOT NULL,
  hash text NOT NULL
);
CREATE INDEX audit_entity_idx ON audit_log(entity_type, entity_id, id DESC);
CREATE INDEX audit_at_idx ON audit_log(at DESC);

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  bank_id uuid REFERENCES banks(id),
  loan_id uuid REFERENCES loans(id),
  title text NOT NULL,
  message text NOT NULL,
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  resolved_at timestamptz
);
CREATE UNIQUE INDEX alerts_active_key_idx ON alerts(dedupe_key) WHERE status <> 'resolved';
CREATE INDEX alerts_status_idx ON alerts(status, created_at DESC);
CREATE INDEX alerts_key_idx ON alerts(dedupe_key, created_at DESC);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid REFERENCES alerts(id),
  user_id uuid REFERENCES users(id),
  channel text NOT NULL CHECK (channel IN ('email','sms')),
  recipient text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX notifications_status_idx ON notifications(status, created_at);

INSERT INTO settings(key, value) VALUES
  ('require_approval', 'true'),
  ('warn_buffer_pct', '10'),
  ('maturity_reminder_days', '[90, 60, 30, 14, 7]'),
  ('review_reminder_days', '[60, 30, 7]'),
  ('charge_reminder_days', '[7, 3, 1]'),
  ('document_expiry_reminder_days', '[30, 7]');
