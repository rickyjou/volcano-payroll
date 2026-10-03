CREATE POLICY payroll_run_lines_own ON payroll_run_lines FOR SELECT
    USING (employee_id = app_current_employee_id() AND app_run_is_finalized(run_id));
