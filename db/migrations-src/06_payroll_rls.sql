-- Payroll tables are admin-only, except employees can read their own lines
-- from finalized runs. Integrations use the service key (bypasses RLS).

-- @file 160_payroll_runs_rls
ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;

-- @file 161_payroll_run_lines_rls
ALTER TABLE payroll_run_lines ENABLE ROW LEVEL SECURITY;

-- @file 162_export_mappings_rls
ALTER TABLE export_mappings ENABLE ROW LEVEL SECURITY;

-- @file 163_exports_rls
ALTER TABLE exports ENABLE ROW LEVEL SECURITY;

-- @file 164_api_keys_rls
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- @file 165_webhook_endpoints_rls
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;

-- @file 166_webhook_deliveries_rls
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- @file 170_payroll_runs_admin_drop
DROP POLICY IF EXISTS payroll_runs_admin ON payroll_runs;

-- @file 171_payroll_runs_admin_create
CREATE POLICY payroll_runs_admin ON payroll_runs FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 172_payroll_run_lines_admin_drop
DROP POLICY IF EXISTS payroll_run_lines_admin ON payroll_run_lines;

-- @file 173_payroll_run_lines_admin_create
CREATE POLICY payroll_run_lines_admin ON payroll_run_lines FOR SELECT
    USING (app_is_admin());

-- @file 174_payroll_run_lines_own_drop
DROP POLICY IF EXISTS payroll_run_lines_own ON payroll_run_lines;

-- @file 175_payroll_run_lines_own_create
CREATE POLICY payroll_run_lines_own ON payroll_run_lines FOR SELECT
    USING (employee_id = app_current_employee_id() AND app_run_is_finalized(run_id));

-- @file 176_export_mappings_admin_drop
DROP POLICY IF EXISTS export_mappings_admin ON export_mappings;

-- @file 177_export_mappings_admin_create
CREATE POLICY export_mappings_admin ON export_mappings FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 178_exports_admin_drop
DROP POLICY IF EXISTS exports_admin ON exports;

-- @file 179_exports_admin_create
CREATE POLICY exports_admin ON exports FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 180_api_keys_admin_drop
DROP POLICY IF EXISTS api_keys_admin ON api_keys;

-- @file 181_api_keys_admin_create
CREATE POLICY api_keys_admin ON api_keys FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 182_webhook_endpoints_admin_drop
DROP POLICY IF EXISTS webhook_endpoints_admin ON webhook_endpoints;

-- @file 183_webhook_endpoints_admin_create
CREATE POLICY webhook_endpoints_admin ON webhook_endpoints FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- @file 184_webhook_deliveries_admin_drop
DROP POLICY IF EXISTS webhook_deliveries_admin ON webhook_deliveries;

-- @file 185_webhook_deliveries_admin_create
CREATE POLICY webhook_deliveries_admin ON webhook_deliveries FOR ALL
    USING (app_is_admin()) WITH CHECK (app_is_admin());
