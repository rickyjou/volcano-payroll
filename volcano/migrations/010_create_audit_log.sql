CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    actor_employee_id UUID,
    actor_user_id UUID,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
