-- Chat agent: saved conversations and pending / undoable actions. Every row belongs to
-- one signed-in user and only that user can read or change it.

-- @file 203_create_chat_messages
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

-- @file 204_chat_messages_user_idx
CREATE INDEX IF NOT EXISTS chat_messages_user_created ON chat_messages (user_id, created_at);

-- @file 205_create_agent_actions
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

-- @file 206_agent_actions_user_idx
CREATE INDEX IF NOT EXISTS agent_actions_user_status ON agent_actions (user_id, status, created_at);

-- @file 207_chat_messages_rls
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- @file 208_chat_messages_own_drop
DROP POLICY IF EXISTS chat_messages_own ON chat_messages;

-- @file 209_chat_messages_own_create
CREATE POLICY chat_messages_own ON chat_messages FOR ALL
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- @file 210_agent_actions_rls
ALTER TABLE agent_actions ENABLE ROW LEVEL SECURITY;

-- @file 211_agent_actions_own_drop
DROP POLICY IF EXISTS agent_actions_own ON agent_actions;

-- @file 212_agent_actions_own_create
CREATE POLICY agent_actions_own ON agent_actions FOR ALL
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
