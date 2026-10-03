-- Role helpers, guard triggers and auditing. Errors raised here use the
-- prefixes CONFLICT:<CODE>: and FORBIDDEN:<CODE>: so functions can map them
-- to HTTP 409 / 403 (see src/server/http.ts).
-- auth.uid() is NULL only for service-key requests (anon requests are
-- stopped by RLS before triggers run), so guards treat NULL as "system".

-- @file 020_fn_app_current_employee_id
CREATE OR REPLACE FUNCTION app_current_employee_id() RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT id FROM employees WHERE user_id = auth.uid() AND status = 'active'
$$;

-- @file 021_fn_app_is_admin
CREATE OR REPLACE FUNCTION app_is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM employees WHERE user_id = auth.uid() AND status = 'active' AND role = 'admin'
    )
$$;

-- @file 022_fn_app_is_manager_of
CREATE OR REPLACE FUNCTION app_is_manager_of(emp UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM employees e
        WHERE e.id = emp AND e.manager_id IS NOT NULL AND e.manager_id = app_current_employee_id()
    )
$$;

-- @file 023_fn_app_can_read_timesheet
CREATE OR REPLACE FUNCTION app_can_read_timesheet(ts UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM timesheets t
        WHERE t.id = ts
          AND (t.employee_id = app_current_employee_id() OR app_is_manager_of(t.employee_id) OR app_is_admin())
    )
$$;

-- @file 024_fn_app_owns_timesheet
CREATE OR REPLACE FUNCTION app_owns_timesheet(ts UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM timesheets t WHERE t.id = ts AND t.employee_id = app_current_employee_id())
$$;

-- @file 025_fn_app_audit
CREATE OR REPLACE FUNCTION app_audit(p_action TEXT, p_entity TEXT, p_entity_id TEXT, p_details JSONB) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    INSERT INTO audit_log (actor_employee_id, actor_user_id, action, entity, entity_id, details)
    VALUES (app_current_employee_id(), auth.uid(), p_action, p_entity, p_entity_id, COALESCE(p_details, '{}'::jsonb))
$$;

-- @file 026_fn_audit_row_change
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    old_row JSONB := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) - 'key_hash' - 'secret' - 'content' END;
    new_row JSONB := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) - 'key_hash' - 'secret' - 'content' END;
BEGIN
    PERFORM app_audit(lower(TG_OP), TG_TABLE_NAME, COALESCE(new_row ->> 'id', old_row ->> 'id'),
                      jsonb_build_object('old', old_row, 'new', new_row));
    RETURN NULL;
END
$$;

-- @file 027_fn_touch_updated_at
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END
$$;

-- @file 028_fn_employees_guard
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

-- @file 029_fn_pay_periods_guard
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

-- @file 030_fn_timesheets_guard
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

-- @file 031_fn_time_entries_guard
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

-- @file 040_trg_employees_guard_drop
DROP TRIGGER IF EXISTS employees_guard ON employees;

-- @file 041_trg_employees_guard_create
CREATE TRIGGER employees_guard BEFORE UPDATE OR DELETE ON employees
    FOR EACH ROW EXECUTE FUNCTION employees_guard();

-- @file 042_trg_employees_audit_drop
DROP TRIGGER IF EXISTS employees_audit ON employees;

-- @file 043_trg_employees_audit_create
CREATE TRIGGER employees_audit AFTER INSERT OR UPDATE OR DELETE ON employees
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- @file 044_trg_compensation_audit_drop
DROP TRIGGER IF EXISTS compensation_audit ON compensation;

-- @file 045_trg_compensation_audit_create
CREATE TRIGGER compensation_audit AFTER INSERT OR UPDATE OR DELETE ON compensation
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- @file 046_trg_settings_touch_drop
DROP TRIGGER IF EXISTS settings_touch ON settings;

-- @file 047_trg_settings_touch_create
CREATE TRIGGER settings_touch BEFORE UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- @file 048_trg_settings_audit_drop
DROP TRIGGER IF EXISTS settings_audit ON settings;

-- @file 049_trg_settings_audit_create
CREATE TRIGGER settings_audit AFTER UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- @file 050_trg_pay_periods_guard_drop
DROP TRIGGER IF EXISTS pay_periods_guard ON pay_periods;

-- @file 051_trg_pay_periods_guard_create
CREATE TRIGGER pay_periods_guard BEFORE UPDATE OR DELETE ON pay_periods
    FOR EACH ROW EXECUTE FUNCTION pay_periods_guard();

-- @file 052_trg_pay_periods_audit_drop
DROP TRIGGER IF EXISTS pay_periods_audit ON pay_periods;

-- @file 053_trg_pay_periods_audit_create
CREATE TRIGGER pay_periods_audit AFTER INSERT OR UPDATE OR DELETE ON pay_periods
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- @file 054_trg_timesheets_guard_drop
DROP TRIGGER IF EXISTS timesheets_guard ON timesheets;

-- @file 055_trg_timesheets_guard_create
CREATE TRIGGER timesheets_guard BEFORE INSERT OR UPDATE ON timesheets
    FOR EACH ROW EXECUTE FUNCTION timesheets_guard();

-- @file 056_trg_time_entries_guard_drop
DROP TRIGGER IF EXISTS time_entries_guard ON time_entries;

-- @file 057_trg_time_entries_guard_create
CREATE TRIGGER time_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON time_entries
    FOR EACH ROW EXECUTE FUNCTION time_entries_guard();
