CREATE TRIGGER api_keys_audit AFTER INSERT OR DELETE OR UPDATE OF revoked_at, name ON api_keys
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
