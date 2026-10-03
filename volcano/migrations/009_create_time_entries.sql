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
