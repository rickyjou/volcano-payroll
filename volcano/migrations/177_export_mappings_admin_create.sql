CREATE POLICY export_mappings_admin ON export_mappings FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());
