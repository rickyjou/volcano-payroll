CREATE OR REPLACE FUNCTION timesheets_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    me UUID := app_current_employee_id();
    is_admin BOOLEAN := app_is_admin();
    p_status TEXT;
BEGIN
    SELECT status INTO p_status FROM pay_periods WHERE id = NEW.pay_period_id;
    IF auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'draft' THEN
            RAISE EXCEPTION 'CONFLICT:INVALID_TRANSITION: new timesheets start as draft';
        END IF;
        IF p_status <> 'open' THEN
            RAISE EXCEPTION 'CONFLICT:PERIOD_NOT_OPEN: this pay period is not open for time entry';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.employee_id <> OLD.employee_id OR NEW.pay_period_id <> OLD.pay_period_id THEN
        RAISE EXCEPTION 'CONFLICT:IMMUTABLE: a timesheet cannot move to another employee or period';
    END IF;
    IF p_status = 'finalized' THEN
        RAISE EXCEPTION 'CONFLICT:PERIOD_FINALIZED: payroll for this period is finalized';
    END IF;
    NEW.updated_at := now();
    IF NEW.status = OLD.status THEN
        IF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
           OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
            RAISE EXCEPTION 'CONFLICT:IMMUTABLE: approval fields only change with the status';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status IN ('draft', 'rejected') AND NEW.status = 'submitted' AND OLD.employee_id = me THEN
        IF p_status <> 'open' THEN
            RAISE EXCEPTION 'CONFLICT:PERIOD_NOT_OPEN: this pay period is not open for time entry';
        END IF;
        NEW.submitted_at := now();
        NEW.rejection_note := NULL;
    ELSIF OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected')
          AND (is_admin OR app_is_manager_of(OLD.employee_id)) THEN
        IF NEW.status = 'approved' THEN
            NEW.approved_by := me;
            NEW.approved_at := now();
            NEW.rejection_note := NULL;
        ELSIF btrim(COALESCE(NEW.rejection_note, '')) = '' THEN
            RAISE EXCEPTION 'CONFLICT:NOTE_REQUIRED: give a reason when rejecting a timesheet';
        END IF;
    ELSIF OLD.status = 'submitted' AND NEW.status = 'draft' AND (OLD.employee_id = me OR is_admin) THEN
        IF p_status <> 'open' THEN
            RAISE EXCEPTION 'CONFLICT:PERIOD_NOT_OPEN: reopen the pay period first';
        END IF;
        NEW.submitted_at := NULL;
    ELSIF OLD.status = 'approved' AND NEW.status = 'draft' AND is_admin THEN
        IF p_status <> 'open' THEN
            RAISE EXCEPTION 'CONFLICT:PERIOD_NOT_OPEN: reopen the pay period first';
        END IF;
        NEW.submitted_at := NULL;
        NEW.approved_by := NULL;
        NEW.approved_at := NULL;
    ELSE
        RAISE EXCEPTION 'CONFLICT:INVALID_TRANSITION: cannot change a timesheet from % to %', OLD.status, NEW.status;
    END IF;
    PERFORM app_audit('timesheet.' || NEW.status, 'timesheets', NEW.id::text,
                      jsonb_build_object('from', OLD.status, 'note', NEW.rejection_note));
    RETURN NEW;
END
$$;
