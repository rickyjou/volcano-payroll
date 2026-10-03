CREATE TRIGGER compensation_audit AFTER INSERT OR UPDATE OR DELETE ON compensation
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
