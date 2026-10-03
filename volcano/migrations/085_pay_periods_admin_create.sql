CREATE POLICY pay_periods_admin ON pay_periods FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());
