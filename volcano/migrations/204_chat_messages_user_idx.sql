CREATE INDEX IF NOT EXISTS chat_messages_user_created ON chat_messages (user_id, created_at);
