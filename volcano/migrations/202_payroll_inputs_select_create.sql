CREATE POLICY payroll_inputs_select ON payroll_inputs FOR SELECT USING (app_is_admin());
