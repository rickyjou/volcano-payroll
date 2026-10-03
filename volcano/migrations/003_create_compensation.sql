CREATE TABLE IF NOT EXISTS compensation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    pay_type TEXT NOT NULL CHECK (pay_type IN ('salary', 'hourly', 'daily')),
    rate_cents BIGINT NOT NULL CHECK (rate_cents > 0),
    effective_from DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (employee_id, effective_from)
);
