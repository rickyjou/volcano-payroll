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
