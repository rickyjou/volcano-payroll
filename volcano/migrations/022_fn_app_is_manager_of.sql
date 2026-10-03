CREATE OR REPLACE FUNCTION app_is_manager_of(emp UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM employees e
        WHERE e.id = emp AND e.manager_id IS NOT NULL AND e.manager_id = app_current_employee_id()
    )
$$;
