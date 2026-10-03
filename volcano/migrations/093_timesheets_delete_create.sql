CREATE POLICY timesheets_delete ON timesheets FOR DELETE
    USING (app_is_admin());
