CREATE OR REPLACE FUNCTION app_can_read_timesheet(ts UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM timesheets t
        WHERE t.id = ts
          AND (t.employee_id = app_current_employee_id() OR app_is_manager_of(t.employee_id) OR app_is_admin())
    )
$$;
