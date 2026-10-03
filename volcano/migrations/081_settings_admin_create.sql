CREATE POLICY settings_admin ON settings FOR UPDATE
    USING (app_is_admin()) WITH CHECK (app_is_admin());
