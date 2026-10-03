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
