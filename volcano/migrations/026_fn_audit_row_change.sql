CREATE OR REPLACE FUNCTION audit_row_change() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    old_row JSONB := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) - 'key_hash' - 'secret' - 'content' END;
    new_row JSONB := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) - 'key_hash' - 'secret' - 'content' END;
BEGIN
    PERFORM app_audit(lower(TG_OP), TG_TABLE_NAME, COALESCE(new_row ->> 'id', old_row ->> 'id'),
                      jsonb_build_object('old', old_row, 'new', new_row));
    RETURN NULL;
END
$$;
