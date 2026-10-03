CREATE TRIGGER pay_periods_guard BEFORE UPDATE OR DELETE ON pay_periods
    FOR EACH ROW EXECUTE FUNCTION pay_periods_guard();
