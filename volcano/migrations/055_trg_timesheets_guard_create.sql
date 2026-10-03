CREATE TRIGGER timesheets_guard BEFORE INSERT OR UPDATE ON timesheets
    FOR EACH ROW EXECUTE FUNCTION timesheets_guard();
