CREATE TRIGGER compensation_inputs AFTER INSERT OR UPDATE OR DELETE ON compensation
    FOR EACH STATEMENT EXECUTE FUNCTION payroll_inputs_bump();
