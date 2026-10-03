CREATE TRIGGER export_mappings_audit AFTER INSERT OR UPDATE OR DELETE ON export_mappings
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
