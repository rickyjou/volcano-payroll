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
