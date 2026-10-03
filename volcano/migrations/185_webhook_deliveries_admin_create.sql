CREATE POLICY webhook_deliveries_admin ON webhook_deliveries FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());
