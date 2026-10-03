CREATE TRIGGER export_mappings_touch BEFORE UPDATE ON export_mappings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
