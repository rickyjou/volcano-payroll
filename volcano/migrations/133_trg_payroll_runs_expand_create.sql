CREATE TRIGGER payroll_runs_expand AFTER INSERT ON payroll_runs
    FOR EACH ROW EXECUTE FUNCTION payroll_runs_expand_lines();
