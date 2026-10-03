CREATE TABLE IF NOT EXISTS pay_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    start_date DATE NOT NULL UNIQUE CHECK (start_date = date_trunc('month', start_date)::date),
    end_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'finalized')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_date = (start_date + INTERVAL '1 month' - INTERVAL '1 day')::date)
);
