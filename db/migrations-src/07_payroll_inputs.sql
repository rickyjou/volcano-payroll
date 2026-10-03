-- Change counter for everything a payroll run is calculated from. Any insert, update or
-- delete of the inputs bumps it; a draft records the version it was calculated from
-- (read before the data), and finalize refuses with RUN_STALE when it has moved.

-- @file 186_create_payroll_inputs
CREATE TABLE IF NOT EXISTS payroll_inputs (
    id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    version BIGINT NOT NULL DEFAULT 0
);

-- @file 187_seed_payroll_inputs
INSERT INTO payroll_inputs (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- @file 188_payroll_runs_inputs_version
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS inputs_version BIGINT;

-- @file 189_fn_payroll_inputs_bump
CREATE OR REPLACE FUNCTION payroll_inputs_bump() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE payroll_inputs SET version = version + 1 WHERE id;
    RETURN NULL;
END
$$;

-- @file 190_trg_employees_inputs_drop
DROP TRIGGER IF EXISTS employees_inputs ON employees;

-- @file 191_trg_employees_inputs_create
CREATE TRIGGER employees_inputs AFTER INSERT OR UPDATE OR DELETE ON employees
    FOR EACH STATEMENT EXECUTE FUNCTION payroll_inputs_bump();

-- @file 192_trg_compensation_inputs_drop
DROP TRIGGER IF EXISTS compensation_inputs ON compensation;

-- @file 193_trg_compensation_inputs_create
CREATE TRIGGER compensation_inputs AFTER INSERT OR UPDATE OR DELETE ON compensation
    FOR EACH STATEMENT EXECUTE FUNCTION payroll_inputs_bump();

-- @file 194_trg_timesheets_inputs_drop
DROP TRIGGER IF EXISTS timesheets_inputs ON timesheets;

-- @file 195_trg_timesheets_inputs_create
CREATE TRIGGER timesheets_inputs AFTER INSERT OR UPDATE OR DELETE ON timesheets
    FOR EACH STATEMENT EXECUTE FUNCTION payroll_inputs_bump();

-- @file 196_trg_time_entries_inputs_drop
DROP TRIGGER IF EXISTS time_entries_inputs ON time_entries;

-- @file 197_trg_time_entries_inputs_create
CREATE TRIGGER time_entries_inputs AFTER INSERT OR UPDATE OR DELETE ON time_entries
    FOR EACH STATEMENT EXECUTE FUNCTION payroll_inputs_bump();

-- @file 198_trg_settings_inputs_drop
DROP TRIGGER IF EXISTS settings_inputs ON settings;

-- @file 199_trg_settings_inputs_create
CREATE TRIGGER settings_inputs AFTER INSERT OR UPDATE OR DELETE ON settings
    FOR EACH STATEMENT EXECUTE FUNCTION payroll_inputs_bump();

-- @file 200_payroll_inputs_rls
ALTER TABLE payroll_inputs ENABLE ROW LEVEL SECURITY;

-- @file 201_payroll_inputs_select_drop
DROP POLICY IF EXISTS payroll_inputs_select ON payroll_inputs;

-- @file 202_payroll_inputs_select_create
CREATE POLICY payroll_inputs_select ON payroll_inputs FOR SELECT USING (app_is_admin());
