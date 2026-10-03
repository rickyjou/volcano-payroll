CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    prefix TEXT NOT NULL UNIQUE CHECK (prefix ~ '^[0-9a-f]{8}$'),
    key_hash TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    created_by UUID REFERENCES employees(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
