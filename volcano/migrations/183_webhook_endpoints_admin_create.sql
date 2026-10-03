CREATE POLICY webhook_endpoints_admin ON webhook_endpoints FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());
