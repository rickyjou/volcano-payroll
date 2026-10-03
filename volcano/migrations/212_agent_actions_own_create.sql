CREATE POLICY agent_actions_own ON agent_actions FOR ALL
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
