CREATE TRIGGER exports_audit AFTER INSERT ON exports
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
