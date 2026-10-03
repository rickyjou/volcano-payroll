CREATE TABLE IF NOT EXISTS agent_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    tool TEXT NOT NULL,
    args JSONB NOT NULL DEFAULT '{}'::jsonb,
    confirmation JSONB,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'done', 'cancelled', 'expired', 'undone', 'failed')),
    undo JSONB,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
