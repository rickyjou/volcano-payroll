CREATE POLICY time_entries_select ON time_entries FOR SELECT
    USING (app_can_read_timesheet(timesheet_id));
