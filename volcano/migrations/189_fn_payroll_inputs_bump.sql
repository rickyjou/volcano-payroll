CREATE OR REPLACE FUNCTION payroll_inputs_bump() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE payroll_inputs SET version = version + 1 WHERE id;
    RETURN NULL;
END
$$;
