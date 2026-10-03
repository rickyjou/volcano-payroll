CREATE POLICY employees_admin ON employees FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());
