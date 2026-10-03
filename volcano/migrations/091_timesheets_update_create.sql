CREATE POLICY timesheets_update ON timesheets FOR UPDATE
    USING (employee_id = app_current_employee_id() OR app_is_manager_of(employee_id) OR app_is_admin())
    WITH CHECK (employee_id = app_current_employee_id() OR app_is_manager_of(employee_id) OR app_is_admin());
