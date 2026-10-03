CREATE TRIGGER employees_guard BEFORE UPDATE OR DELETE ON employees
    FOR EACH ROW EXECUTE FUNCTION employees_guard();
