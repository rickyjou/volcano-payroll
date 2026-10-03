CREATE POLICY settings_select ON settings FOR SELECT
    USING (app_current_employee_id() IS NOT NULL);
