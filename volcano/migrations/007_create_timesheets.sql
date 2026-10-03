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
