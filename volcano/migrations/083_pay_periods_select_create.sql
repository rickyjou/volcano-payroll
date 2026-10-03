CREATE POLICY pay_periods_select ON pay_periods FOR SELECT
    USING (app_current_employee_id() IS NOT NULL);
