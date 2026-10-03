CREATE OR REPLACE FUNCTION payroll_runs_expand_lines() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NEW.lines_input IS NULL THEN
        RETURN NULL;
    END IF;
    INSERT INTO payroll_run_lines (run_id, pay_period_id, employee_id, external_id, first_name, last_name, email, pay_type,
                                   work_state, earning_code, hours, days, rate_cents, amount_cents)
    SELECT NEW.id, NEW.pay_period_id, l.employee_id, l.external_id, l.first_name, l.last_name, l.email, l.pay_type,
           l.work_state, l.earning_code, l.hours, l.days, l.rate_cents, l.amount_cents
    FROM jsonb_to_recordset(NEW.lines_input::jsonb) AS l(
        employee_id UUID, external_id TEXT, first_name TEXT, last_name TEXT, email TEXT, pay_type TEXT,
        work_state TEXT, earning_code TEXT, hours NUMERIC, days NUMERIC, rate_cents BIGINT, amount_cents BIGINT);
    UPDATE payroll_runs SET lines_input = NULL WHERE id = NEW.id;
    RETURN NULL;
END
$$;
