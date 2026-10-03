CREATE OR REPLACE FUNCTION payroll_runs_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    p_status TEXT;
BEGIN
    IF auth.uid() IS NOT NULL AND NOT app_is_admin() THEN
        RAISE EXCEPTION 'FORBIDDEN:ADMIN_ONLY: only admins can change payroll runs';
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF auth.uid() IS NOT NULL AND OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'CONFLICT:RUN_FROZEN: only draft runs can be deleted';
        END IF;
        RETURN OLD;
    END IF;
    SELECT status INTO p_status FROM pay_periods WHERE id = NEW.pay_period_id;
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'draft' THEN
            RAISE EXCEPTION 'CONFLICT:INVALID_TRANSITION: new runs start as draft';
        END IF;
        IF p_status <> 'locked' THEN
            RAISE EXCEPTION 'CONFLICT:PERIOD_NOT_LOCKED: lock the pay period before generating a run';
        END IF;
        NEW.generated_by := app_current_employee_id();
        NEW.generated_at := now();
        -- The caller passes the version it read before loading the data; never later than now.
        SELECT LEAST(COALESCE(NEW.inputs_version, version), version) INTO NEW.inputs_version FROM payroll_inputs;
        RETURN NEW;
    END IF;

    IF NEW.pay_period_id <> OLD.pay_period_id OR NEW.totals IS DISTINCT FROM OLD.totals
       OR NEW.warnings IS DISTINCT FROM OLD.warnings OR NEW.skipped_employee_ids IS DISTINCT FROM OLD.skipped_employee_ids
       OR NEW.generated_at IS DISTINCT FROM OLD.generated_at OR NEW.inputs_version IS DISTINCT FROM OLD.inputs_version THEN
        RAISE EXCEPTION 'CONFLICT:RUN_FROZEN: regenerate the draft instead of editing it';
    END IF;
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'draft' AND NEW.status = 'finalized' THEN
        IF p_status <> 'locked' THEN
            RAISE EXCEPTION 'CONFLICT:PERIOD_NOT_LOCKED: the pay period must be locked to finalize';
        END IF;
        IF jsonb_path_exists(NEW.warnings, '$[*] ? (@.blocking == true)') THEN
            RAISE EXCEPTION 'CONFLICT:RUN_HAS_BLOCKING_WARNINGS: fix or skip the flagged employees, then regenerate';
        END IF;
        IF EXISTS (SELECT 1 FROM payroll_inputs WHERE version <> COALESCE(OLD.inputs_version, -1)) THEN
            RAISE EXCEPTION 'CONFLICT:RUN_STALE: payroll data (time, pay, employees or settings) changed after this draft was generated; regenerate it';
        END IF;
        NEW.finalized_by := app_current_employee_id();
        NEW.finalized_at := now();
    ELSIF OLD.status = 'finalized' AND NEW.status = 'voided' THEN
        IF btrim(COALESCE(NEW.void_reason, '')) = '' THEN
            RAISE EXCEPTION 'CONFLICT:NOTE_REQUIRED: give a reason for voiding the run';
        END IF;
        NEW.voided_by := app_current_employee_id();
        NEW.voided_at := now();
    ELSE
        RAISE EXCEPTION 'CONFLICT:INVALID_TRANSITION: cannot change a run from % to %', OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END
$$;
