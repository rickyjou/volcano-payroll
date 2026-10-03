CREATE OR REPLACE FUNCTION pay_periods_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF auth.uid() IS NOT NULL
           AND (OLD.status <> 'open' OR EXISTS (SELECT 1 FROM timesheets WHERE pay_period_id = OLD.id)) THEN
            RAISE EXCEPTION 'CONFLICT:PERIOD_IN_USE: only an open period with no timesheets can be deleted';
        END IF;
        RETURN OLD;
    END IF;
    IF NEW.start_date <> OLD.start_date OR NEW.end_date <> OLD.end_date THEN
        RAISE EXCEPTION 'CONFLICT:IMMUTABLE: pay period dates cannot change';
    END IF;
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;
    IF OLD.status = 'open' AND NEW.status = 'locked' THEN
        RETURN NEW;
    END IF;
    IF OLD.status = 'locked' AND NEW.status = 'open' THEN
        IF EXISTS (SELECT 1 FROM payroll_runs WHERE pay_period_id = OLD.id AND status <> 'voided') THEN
            RAISE EXCEPTION 'CONFLICT:RUN_EXISTS: delete the draft run (or void the finalized run) before reopening';
        END IF;
        RETURN NEW;
    END IF;
    -- locked <-> finalized happens only through payroll run finalize/void.
    IF pg_trigger_depth() > 1
       AND ((OLD.status = 'locked' AND NEW.status = 'finalized') OR (OLD.status = 'finalized' AND NEW.status = 'locked')) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'CONFLICT:INVALID_TRANSITION: cannot change a pay period from % to %', OLD.status, NEW.status;
END
$$;
