CREATE TRIGGER payroll_runs_after_update AFTER UPDATE ON payroll_runs
    FOR EACH ROW EXECUTE FUNCTION payroll_runs_after_update();
