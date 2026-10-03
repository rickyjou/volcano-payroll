CREATE POLICY compensation_admin ON compensation FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());
