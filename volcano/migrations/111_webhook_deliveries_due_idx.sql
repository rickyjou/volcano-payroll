CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries(status, next_attempt_at);
