CREATE INDEX IF NOT EXISTS agent_actions_user_status ON agent_actions (user_id, status, created_at);
