CREATE TRIGGER settings_audit AFTER UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
