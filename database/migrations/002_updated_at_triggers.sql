-- 002_updated_at_triggers.sql
--
-- updated_at is maintained by the database rather than by each repository
-- method. A service that forgets to touch the column cannot produce a stale
-- timestamp, and the value is correct even for ad-hoc SQL run during a demo.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER rooms_set_updated_at
    BEFORE UPDATE ON rooms
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER drafts_set_updated_at
    BEFORE UPDATE ON drafts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER spins_set_updated_at
    BEFORE UPDATE ON spins
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
