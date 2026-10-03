CREATE OR REPLACE FUNCTION employees_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        NEW.updated_at := now();
    END IF;
    IF auth.uid() IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF OLD.role = 'admin' AND OLD.status = 'active'
       AND (TG_OP = 'DELETE' OR NEW.role <> 'admin' OR NEW.status <> 'active')
       AND NOT EXISTS (SELECT 1 FROM employees WHERE role = 'admin' AND status = 'active' AND id <> OLD.id) THEN
        RAISE EXCEPTION 'CONFLICT:LAST_ADMIN: keep at least one active admin';
    END IF;
    RETURN COALESCE(NEW, OLD);
END
$$;
