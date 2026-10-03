CREATE POLICY audit_log_select ON audit_log FOR SELECT
    USING (app_is_admin());
