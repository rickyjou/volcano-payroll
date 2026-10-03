CREATE POLICY time_entries_write ON time_entries FOR ALL
    USING (app_owns_timesheet(timesheet_id) OR app_is_admin())
    WITH CHECK (app_owns_timesheet(timesheet_id) OR app_is_admin());
