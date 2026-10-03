CREATE OR REPLACE FUNCTION app_audit(p_action TEXT, p_entity TEXT, p_entity_id TEXT, p_details JSONB) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    INSERT INTO audit_log (actor_employee_id, actor_user_id, action, entity, entity_id, details)
    VALUES (app_current_employee_id(), auth.uid(), p_action, p_entity, p_entity_id, COALESCE(p_details, '{}'::jsonb))
$$;
