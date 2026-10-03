CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL DEFAULT '',
    cards JSONB NOT NULL DEFAULT '[]'::jsonb,
    path TEXT CHECK (path IN ('decider', 'llm', 'ask', 'action', 'error')),
    confidence NUMERIC(4,3),
    latency_ms INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
