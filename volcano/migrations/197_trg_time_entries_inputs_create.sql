CREATE TRIGGER time_entries_inputs AFTER INSERT OR UPDATE OR DELETE ON time_entries
    FOR EACH STATEMENT EXECUTE FUNCTION payroll_inputs_bump();
