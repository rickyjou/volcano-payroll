CREATE POLICY timesheets_insert ON timesheets FOR INSERT
    WITH CHECK (employee_id = app_current_employee_id() OR app_is_admin());
