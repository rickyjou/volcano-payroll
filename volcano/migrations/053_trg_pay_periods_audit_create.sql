CREATE TRIGGER pay_periods_audit AFTER INSERT OR UPDATE OR DELETE ON pay_periods
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
