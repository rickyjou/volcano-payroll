CREATE TRIGGER settings_touch BEFORE UPDATE ON settings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
