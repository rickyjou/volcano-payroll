CREATE POLICY exports_admin ON exports FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());
