-- Row-level security for core tables. Policies are OR'ed together.

-- @file 060_employees_rls
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;

-- @file 061_compensation_rls
ALTER TABLE compensation ENABLE ROW LEVEL SECURITY;

-- @file 062_settings_rls
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- @file 063_pay_periods_rls
ALTER TABLE pay_periods ENABLE ROW LEVEL SECURITY;

-- @file 064_timesheets_rls
ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY;

-- @file 065_time_entries_rls
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;

-- @file 066_audit_log_rls
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- @file 070_employees_select_drop
DROP POLICY IF EXISTS employees_select ON employees;

-- @file 071_employees_select_create
CREATE POLICY employees_select ON employees FOR SELECT
    USING (id = app_current_employee_id() OR manager_id = app_current_employee_id() OR app_is_admin());

-- @file 072_employees_admin_drop
DROP POLICY IF EXISTS employees_admin ON employees;

-- @file 073_employees_admin_create
CREATE POLICY employees_admin ON employees FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 074_compensation_select_drop
DROP POLICY IF EXISTS compensation_select ON compensation;

-- @file 075_compensation_select_create
CREATE POLICY compensation_select ON compensation FOR SELECT
    USING (employee_id = app_current_employee_id() OR app_is_admin());

-- @file 076_compensation_admin_drop
DROP POLICY IF EXISTS compensation_admin ON compensation;

-- @file 077_compensation_admin_create
CREATE POLICY compensation_admin ON compensation FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 078_settings_select_drop
DROP POLICY IF EXISTS settings_select ON settings;

-- @file 079_settings_select_create
CREATE POLICY settings_select ON settings FOR SELECT
    USING (app_current_employee_id() IS NOT NULL);

-- @file 080_settings_admin_drop
DROP POLICY IF EXISTS settings_admin ON settings;

-- @file 081_settings_admin_create
CREATE POLICY settings_admin ON settings FOR UPDATE
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 082_pay_periods_select_drop
DROP POLICY IF EXISTS pay_periods_select ON pay_periods;

-- @file 083_pay_periods_select_create
CREATE POLICY pay_periods_select ON pay_periods FOR SELECT
    USING (app_current_employee_id() IS NOT NULL);

-- @file 084_pay_periods_admin_drop
DROP POLICY IF EXISTS pay_periods_admin ON pay_periods;

-- @file 085_pay_periods_admin_create
CREATE POLICY pay_periods_admin ON pay_periods FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 086_timesheets_select_drop
DROP POLICY IF EXISTS timesheets_select ON timesheets;

-- @file 087_timesheets_select_create
CREATE POLICY timesheets_select ON timesheets FOR SELECT
    USING (employee_id = app_current_employee_id() OR app_is_manager_of(employee_id) OR app_is_admin());

-- @file 088_timesheets_insert_drop
DROP POLICY IF EXISTS timesheets_insert ON timesheets;

-- @file 089_timesheets_insert_create
CREATE POLICY timesheets_insert ON timesheets FOR INSERT
    WITH CHECK (employee_id = app_current_employee_id() OR app_is_admin());

-- @file 090_timesheets_update_drop
DROP POLICY IF EXISTS timesheets_update ON timesheets;

-- @file 091_timesheets_update_create
CREATE POLICY timesheets_update ON timesheets FOR UPDATE
    USING (employee_id = app_current_employee_id() OR app_is_manager_of(employee_id) OR app_is_admin())
    WITH CHECK (employee_id = app_current_employee_id() OR app_is_manager_of(employee_id) OR app_is_admin());

-- @file 092_timesheets_delete_drop
DROP POLICY IF EXISTS timesheets_delete ON timesheets;

-- @file 093_timesheets_delete_create
CREATE POLICY timesheets_delete ON timesheets FOR DELETE
    USING (app_is_admin());

-- @file 094_time_entries_select_drop
DROP POLICY IF EXISTS time_entries_select ON time_entries;

-- @file 095_time_entries_select_create
CREATE POLICY time_entries_select ON time_entries FOR SELECT
    USING (app_can_read_timesheet(timesheet_id));

-- @file 096_time_entries_write_drop
DROP POLICY IF EXISTS time_entries_write ON time_entries;

-- @file 097_time_entries_write_create
CREATE POLICY time_entries_write ON time_entries FOR ALL
    USING (app_owns_timesheet(timesheet_id) OR app_is_admin())
    WITH CHECK (app_owns_timesheet(timesheet_id) OR app_is_admin());

-- @file 098_audit_log_select_drop
DROP POLICY IF EXISTS audit_log_select ON audit_log;

-- @file 099_audit_log_select_create
CREATE POLICY audit_log_select ON audit_log FOR SELECT
    USING (app_is_admin());
