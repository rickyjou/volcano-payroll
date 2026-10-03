CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_one_active ON payroll_runs(pay_period_id) WHERE status <> 'voided';
