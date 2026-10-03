CREATE OR REPLACE FUNCTION time_entries_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    ts RECORD;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.timesheet_id <> OLD.timesheet_id THEN
        RAISE EXCEPTION 'CONFLICT:IMMUTABLE: an entry cannot move to another timesheet';
    END IF;
    SELECT t.status, p.status AS period_status, p.start_date, p.end_date INTO ts
    FROM timesheets t JOIN pay_periods p ON p.id = t.pay_period_id
    WHERE t.id = COALESCE(NEW.timesheet_id, OLD.timesheet_id);
    IF ts.status NOT IN ('draft', 'rejected') THEN
        RAISE EXCEPTION 'CONFLICT:TIMESHEET_LOCKED: a submitted or approved timesheet cannot be edited';
    END IF;
    IF ts.period_status <> 'open' THEN
        RAISE EXCEPTION 'CONFLICT:PERIOD_NOT_OPEN: this pay period is not open for time entry';
    END IF;
    IF TG_OP <> 'DELETE' AND (NEW.work_date < ts.start_date OR NEW.work_date > ts.end_date) THEN
        RAISE EXCEPTION 'CONFLICT:OUTSIDE_PERIOD: % is outside this pay period', NEW.work_date;
    END IF;
    RETURN COALESCE(NEW, OLD);
END
$$;
