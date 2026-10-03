CREATE POLICY api_keys_admin ON api_keys FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());
