-- Core tables. Volcano re-runs every migration on each deploy (no tracking),
-- so every statement must be idempotent.

-- @file 001_create_employees
CREATE TABLE IF NOT EXISTS employees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE,
    email TEXT NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
    first_name TEXT NOT NULL CHECK (btrim(first_name) <> ''),
    last_name TEXT NOT NULL CHECK (btrim(last_name) <> ''),
    external_id TEXT UNIQUE,
    role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'manager', 'admin')),
    manager_id UUID REFERENCES employees(id) ON DELETE SET NULL CHECK (manager_id <> id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'terminated')),
    hire_date DATE NOT NULL,
    termination_date DATE CHECK (termination_date IS NULL OR termination_date >= hire_date),
    work_state TEXT CHECK (work_state ~ '^[A-Z]{2}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- @file 002_employees_manager_idx
CREATE INDEX IF NOT EXISTS employees_manager_idx ON employees(manager_id);

-- @file 003_create_compensation
CREATE TABLE IF NOT EXISTS compensation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    pay_type TEXT NOT NULL CHECK (pay_type IN ('salary', 'hourly', 'daily')),
    rate_cents BIGINT NOT NULL CHECK (rate_cents > 0),
    effective_from DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (employee_id, effective_from)
);

-- @file 004_create_settings
CREATE TABLE IF NOT EXISTS settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    company_name TEXT NOT NULL DEFAULT 'My Company',
    ot_weekly_threshold NUMERIC(5,2) DEFAULT 40 CHECK (ot_weekly_threshold > 0),
    ot_daily_threshold NUMERIC(5,2) CHECK (ot_daily_threshold > 0 AND ot_daily_threshold <= 24),
    dt_daily_threshold NUMERIC(5,2) CHECK (dt_daily_threshold > 0 AND dt_daily_threshold <= 24),
    ot_multiplier NUMERIC(4,3) NOT NULL DEFAULT 1.5 CHECK (ot_multiplier >= 1),
    dt_multiplier NUMERIC(4,3) NOT NULL DEFAULT 2.0 CHECK (dt_multiplier >= 1),
    ot_applies_to_daily BOOLEAN NOT NULL DEFAULT FALSE,
    week_starts_on SMALLINT NOT NULL DEFAULT 0 CHECK (week_starts_on BETWEEN 0 AND 6),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (dt_daily_threshold IS NULL OR ot_daily_threshold IS NULL OR dt_daily_threshold > ot_daily_threshold)
);

-- @file 005_seed_settings
INSERT INTO settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- @file 006_create_pay_periods
CREATE TABLE IF NOT EXISTS pay_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    start_date DATE NOT NULL UNIQUE CHECK (start_date = date_trunc('month', start_date)::date),
    end_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'finalized')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_date = (start_date + INTERVAL '1 month' - INTERVAL '1 day')::date)
);

-- @file 007_create_timesheets
CREATE TABLE IF NOT EXISTS timesheets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    pay_period_id UUID NOT NULL REFERENCES pay_periods(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
    submitted_at TIMESTAMPTZ,
    approved_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    rejection_note TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (employee_id, pay_period_id)
);

-- @file 008_timesheets_period_idx
CREATE INDEX IF NOT EXISTS timesheets_period_idx ON timesheets(pay_period_id, status);

-- @file 009_create_time_entries
CREATE TABLE IF NOT EXISTS time_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timesheet_id UUID NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
    work_date DATE NOT NULL,
    earning_code TEXT NOT NULL CHECK (earning_code IN ('REG', 'PTO', 'SICK', 'HOL')),
    hours NUMERIC(4,2) CHECK (hours > 0 AND hours <= 24),
    days NUMERIC(2,1) CHECK (days IN (0.5, 1)),
    note TEXT,
    UNIQUE (timesheet_id, work_date, earning_code),
    CHECK (hours IS NOT NULL OR days IS NOT NULL)
);

-- @file 010_create_audit_log
CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    actor_employee_id UUID,
    actor_user_id UUID,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- @file 011_audit_log_created_idx
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC);
