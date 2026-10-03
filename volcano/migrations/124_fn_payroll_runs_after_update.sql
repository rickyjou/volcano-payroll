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
