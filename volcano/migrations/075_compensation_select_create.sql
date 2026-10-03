CREATE POLICY compensation_select ON compensation FOR SELECT
    USING (employee_id = app_current_employee_id() OR app_is_admin());
