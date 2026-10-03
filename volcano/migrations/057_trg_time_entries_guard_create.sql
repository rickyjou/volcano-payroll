CREATE TRIGGER time_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON time_entries
    FOR EACH ROW EXECUTE FUNCTION time_entries_guard();
