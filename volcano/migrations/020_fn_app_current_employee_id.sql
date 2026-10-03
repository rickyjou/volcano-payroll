CREATE OR REPLACE FUNCTION app_current_employee_id() RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT id FROM employees WHERE user_id = auth.uid() AND status = 'active'
$$;
