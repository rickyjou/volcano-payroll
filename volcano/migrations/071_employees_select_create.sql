CREATE POLICY employees_select ON employees FOR SELECT
    USING (id = app_current_employee_id() OR manager_id = app_current_employee_id() OR app_is_admin());
