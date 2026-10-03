CREATE POLICY timesheets_select ON timesheets FOR SELECT
    USING (employee_id = app_current_employee_id() OR app_is_manager_of(employee_id) OR app_is_admin());
