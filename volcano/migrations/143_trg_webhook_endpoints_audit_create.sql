CREATE TRIGGER webhook_endpoints_audit AFTER INSERT OR UPDATE OR DELETE ON webhook_endpoints
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
