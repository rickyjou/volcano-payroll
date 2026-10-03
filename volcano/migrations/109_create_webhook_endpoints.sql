CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT NOT NULL CHECK (url ~ '^https?://'),
    description TEXT,
    secret TEXT NOT NULL CHECK (length(secret) >= 32),
    events JSONB NOT NULL DEFAULT '["payroll_run.finalized", "payroll_run.voided"]'::jsonb,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
