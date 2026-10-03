-- Payroll runs, exports and integrations.

-- @file 100_create_payroll_runs
CREATE TABLE IF NOT EXISTS payroll_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pay_period_id UUID NOT NULL REFERENCES pay_periods(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized', 'voided')),
    totals JSONB NOT NULL DEFAULT '{}'::jsonb,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    skipped_employee_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- JSON text of the calculated lines; expanded into payroll_run_lines by a
    -- trigger on insert (the SDK has no bulk insert or transactions), then cleared.
    lines_input TEXT,
    generated_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finalized_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    finalized_at TIMESTAMPTZ,
    voided_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    voided_at TIMESTAMPTZ,
    void_reason TEXT
);

-- @file 101_payroll_runs_one_active
CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_one_active ON payroll_runs(pay_period_id) WHERE status <> 'voided';

-- @file 102_create_payroll_run_lines
CREATE TABLE IF NOT EXISTS payroll_run_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    -- copied from the run so employees can group their own lines by month
    -- without reading payroll_runs (admin-only: it holds company totals)
    pay_period_id UUID NOT NULL REFERENCES pay_periods(id),
    employee_id UUID NOT NULL REFERENCES employees(id),
    external_id TEXT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    pay_type TEXT NOT NULL CHECK (pay_type IN ('salary', 'hourly', 'daily')),
    work_state TEXT,
    earning_code TEXT NOT NULL CHECK (earning_code IN ('SAL', 'REG', 'OT', 'DT', 'PTO', 'SICK', 'HOL')),
    hours NUMERIC(8,2),
    days NUMERIC(6,1),
    rate_cents BIGINT NOT NULL,
    amount_cents BIGINT NOT NULL
);

-- @file 103_payroll_run_lines_run_idx
CREATE INDEX IF NOT EXISTS payroll_run_lines_run_idx ON payroll_run_lines(run_id);

-- @file 104_payroll_run_lines_employee_idx
CREATE INDEX IF NOT EXISTS payroll_run_lines_employee_idx ON payroll_run_lines(employee_id);

-- @file 105_create_export_mappings
CREATE TABLE IF NOT EXISTS export_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    based_on TEXT,
    config JSONB NOT NULL,
    created_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- @file 106_create_api_keys
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    prefix TEXT NOT NULL UNIQUE CHECK (prefix ~ '^[0-9a-f]{8}$'),
    key_hash TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    created_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

-- @file 107_create_exports
CREATE TABLE IF NOT EXISTS exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES payroll_runs(id),
    mapping_key TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    content TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    created_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- @file 108_exports_run_idx
CREATE INDEX IF NOT EXISTS exports_run_idx ON exports(run_id, created_at DESC);

-- @file 109_create_webhook_endpoints
CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT NOT NULL CHECK (url ~ '^https?://'),
    description TEXT,
    secret TEXT NOT NULL CHECK (length(secret) >= 32),
    events JSONB NOT NULL DEFAULT '["payroll_run.finalized", "payroll_run.voided"]'::jsonb,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- @file 110_create_webhook_deliveries
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_response_code INT,
    last_error TEXT,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- @file 111_webhook_deliveries_due_idx
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries(status, next_attempt_at);
