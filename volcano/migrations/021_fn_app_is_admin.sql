CREATE OR REPLACE FUNCTION app_is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM employees WHERE user_id = auth.uid() AND status = 'active' AND role = 'admin'
    )
$$;
