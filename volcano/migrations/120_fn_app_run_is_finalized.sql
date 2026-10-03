CREATE OR REPLACE FUNCTION app_run_is_finalized(run UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM payroll_runs WHERE id = run AND status = 'finalized')
$$;
