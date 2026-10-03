CREATE POLICY payroll_runs_admin ON payroll_runs FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());
