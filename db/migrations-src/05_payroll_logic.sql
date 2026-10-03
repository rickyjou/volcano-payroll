-- Payroll run lifecycle: draft (period locked) → finalized → voided.

-- @file 120_fn_app_run_is_finalized
CREATE OR REPLACE FUNCTION app_run_is_finalized(run UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (SELECT 1 FROM payroll_runs WHERE id = run AND status = 'finalized')
$$;

-- @file 121_fn_app_enqueue_webhook
CREATE OR REPLACE FUNCTION app_enqueue_webhook(p_event TEXT, p_run UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    body JSONB;
BEGIN
    SELECT jsonb_build_object(
               'id', gen_random_uuid(),
               'event', p_event,
               'created_at', now(),
               'data', jsonb_build_object(
                   'run_id', r.id, 'status', r.status,
                   'period_start', p.start_date, 'period_end', p.end_date,
                   'totals', r.totals))
    INTO body
    FROM payroll_runs r JOIN pay_periods p ON p.id = r.pay_period_id
    WHERE r.id = p_run;
    INSERT INTO webhook_deliveries (endpoint_id, event, payload)
    SELECT e.id, p_event, body FROM webhook_endpoints e WHERE e.active AND e.events ? p_event;
END
$$;

-- @file 122_fn_payroll_runs_guard
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

-- @file 123_fn_payroll_runs_expand_lines
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

-- @file 124_fn_payroll_runs_after_update
CREATE OR REPLACE FUNCTION payroll_runs_after_update() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NULL;
    END IF;
    IF NEW.status = 'finalized' THEN
        UPDATE pay_periods SET status = 'finalized' WHERE id = NEW.pay_period_id;
        PERFORM app_enqueue_webhook('payroll_run.finalized', NEW.id);
    ELSIF NEW.status = 'voided' THEN
        UPDATE pay_periods SET status = 'locked' WHERE id = NEW.pay_period_id;
        PERFORM app_enqueue_webhook('payroll_run.voided', NEW.id);
    END IF;
    PERFORM app_audit('payroll_run.' || NEW.status, 'payroll_runs', NEW.id::text,
                      jsonb_build_object('from', OLD.status, 'reason', NEW.void_reason, 'totals', NEW.totals));
    RETURN NULL;
END
$$;

-- @file 130_trg_payroll_runs_guard_drop
DROP TRIGGER IF EXISTS payroll_runs_guard ON payroll_runs;

-- @file 131_trg_payroll_runs_guard_create
CREATE TRIGGER payroll_runs_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_runs
    FOR EACH ROW EXECUTE FUNCTION payroll_runs_guard();

-- @file 132_trg_payroll_runs_expand_drop
DROP TRIGGER IF EXISTS payroll_runs_expand ON payroll_runs;

-- @file 133_trg_payroll_runs_expand_create
CREATE TRIGGER payroll_runs_expand AFTER INSERT ON payroll_runs
    FOR EACH ROW EXECUTE FUNCTION payroll_runs_expand_lines();

-- @file 134_trg_payroll_runs_after_update_drop
DROP TRIGGER IF EXISTS payroll_runs_after_update ON payroll_runs;

-- @file 135_trg_payroll_runs_after_update_create
CREATE TRIGGER payroll_runs_after_update AFTER UPDATE ON payroll_runs
    FOR EACH ROW EXECUTE FUNCTION payroll_runs_after_update();

-- @file 136_trg_export_mappings_touch_drop
DROP TRIGGER IF EXISTS export_mappings_touch ON export_mappings;

-- @file 137_trg_export_mappings_touch_create
CREATE TRIGGER export_mappings_touch BEFORE UPDATE ON export_mappings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- @file 138_trg_export_mappings_audit_drop
DROP TRIGGER IF EXISTS export_mappings_audit ON export_mappings;

-- @file 139_trg_export_mappings_audit_create
CREATE TRIGGER export_mappings_audit AFTER INSERT OR UPDATE OR DELETE ON export_mappings
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- @file 140_trg_api_keys_audit_drop
DROP TRIGGER IF EXISTS api_keys_audit ON api_keys;

-- @file 141_trg_api_keys_audit_create
CREATE TRIGGER api_keys_audit AFTER INSERT OR DELETE OR UPDATE OF revoked_at, name ON api_keys
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- @file 142_trg_webhook_endpoints_audit_drop
DROP TRIGGER IF EXISTS webhook_endpoints_audit ON webhook_endpoints;

-- @file 143_trg_webhook_endpoints_audit_create
CREATE TRIGGER webhook_endpoints_audit AFTER INSERT OR UPDATE OR DELETE ON webhook_endpoints
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- @file 144_trg_exports_audit_drop
DROP TRIGGER IF EXISTS exports_audit ON exports;

-- @file 145_trg_exports_audit_create
CREATE TRIGGER exports_audit AFTER INSERT ON exports
    FOR EACH ROW EXECUTE FUNCTION audit_row_change();
