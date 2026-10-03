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
