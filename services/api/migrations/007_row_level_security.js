// The Foundation draft's policies for later modules referenced tables not created yet.
// This applies its exact role/policy pattern to every location-scoped table that exists here.
export const up = (pgm) => {
  pgm.sql(`
DO $$ BEGIN
    CREATE ROLE application_runtime_role NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE ROLE application_migration_role NOLOGIN BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    EXECUTE format('GRANT application_runtime_role TO %I', current_user);
    EXECUTE format('GRANT application_migration_role TO %I', current_user);
END $$;

GRANT USAGE ON SCHEMA public TO application_runtime_role, application_migration_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO application_runtime_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO application_migration_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO application_runtime_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO application_migration_role;

ALTER TABLE location_operating_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY location_operating_config_permissive ON location_operating_config AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY location_operating_config_restrictive ON location_operating_config AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)
    WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

ALTER TABLE staff_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_roles_permissive ON staff_roles AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY staff_roles_restrictive ON staff_roles AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid OR location_id IS NULL)
    WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid OR location_id IS NULL);

ALTER TABLE terminals ENABLE ROW LEVEL SECURITY;
CREATE POLICY terminals_permissive ON terminals AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY terminals_restrictive ON terminals AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)
    WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

ALTER TABLE staff_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_sessions_permissive ON staff_sessions AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY staff_sessions_restrictive ON staff_sessions AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)
    WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

ALTER TABLE terminal_pin_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY terminal_pin_attempts_permissive ON terminal_pin_attempts AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY terminal_pin_attempts_restrictive ON terminal_pin_attempts AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (EXISTS (SELECT 1 FROM terminals WHERE terminals.id = terminal_pin_attempts.terminal_id))
    WITH CHECK (EXISTS (SELECT 1 FROM terminals WHERE terminals.id = terminal_pin_attempts.terminal_id));
`);
};
