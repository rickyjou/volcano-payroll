CREATE POLICY payroll_run_lines_admin ON payroll_run_lines FOR SELECT
    USING (app_is_admin());
