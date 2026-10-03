CREATE POLICY chat_messages_own ON chat_messages FOR ALL
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
