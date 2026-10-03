CREATE TRIGGER payroll_runs_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_runs
    FOR EACH ROW EXECUTE FUNCTION payroll_runs_guard();
