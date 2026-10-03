CREATE TABLE IF NOT EXISTS employees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE,
    email TEXT NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
    first_name TEXT NOT NULL CHECK (btrim(first_name) <> ''),
    last_name TEXT NOT NULL CHECK (btrim(last_name) <> ''),
    external_id TEXT UNIQUE,
    role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'manager', 'admin')),
    manager_id UUID REFERENCES employees(id) ON DELETE SET NULL CHECK (manager_id <> id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'terminated')),
    hire_date DATE NOT NULL,
    termination_date DATE CHECK (termination_date IS NULL OR termination_date >= hire_date),
    work_state TEXT CHECK (work_state ~ '^[A-Z]{2}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
