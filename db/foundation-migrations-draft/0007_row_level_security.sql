-- Creates database roles and applies permissive and restrictive RLS policies for all location-scoped tables.
-- Correction Applied: Added PERMISSIVE policies alongside RESTRICTIVE policies, and created a BYPASSRLS migration role.
-- Deviation: For staff_roles, the restrictive policy allows `location_id IS NULL` to support organization-wide role grants.

DO $$ BEGIN
    CREATE ROLE application_runtime_role NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE ROLE application_migration_role NOLOGIN BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Verified gap (caught by executing this migration against a real PostgreSQL instance, not just
-- reading it): RLS policies only govern which rows are visible once a role already has table
-- privileges. Without explicit GRANTs, application_runtime_role has zero access to any table and
-- every query fails with "permission denied", regardless of policies. Grant broad DML here, then
-- lock down the append-only audit/event tables specifically below as defense in depth matching
-- the ADR's "audit tables must never be updated" requirement.
GRANT USAGE ON SCHEMA public TO application_runtime_role, application_migration_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO application_runtime_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO application_migration_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO application_runtime_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO application_migration_role;

-- Append-only tables: the application must never update or delete these rows once written.
-- outbox_events is the one exception that needs UPDATE, to set dispatched_at after delivery.
REVOKE UPDATE, DELETE ON audit_events, cancellations_and_voids, refunds FROM application_runtime_role;
REVOKE DELETE ON outbox_events FROM application_runtime_role;

-- Table: location_operating_config
ALTER TABLE location_operating_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY location_operating_config_permissive ON location_operating_config
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY location_operating_config_restrictive ON location_operating_config
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: staff_roles (Deviation: location_id IS NULL allowed)
ALTER TABLE staff_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_roles_permissive ON staff_roles
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY staff_roles_restrictive ON staff_roles
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid OR location_id IS NULL);

-- Table: terminals
ALTER TABLE terminals ENABLE ROW LEVEL SECURITY;
CREATE POLICY terminals_permissive ON terminals
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY terminals_restrictive ON terminals
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: staff_sessions
ALTER TABLE staff_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_sessions_permissive ON staff_sessions
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY staff_sessions_restrictive ON staff_sessions
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: location_price_overrides
ALTER TABLE location_price_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY location_price_overrides_permissive ON location_price_overrides
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY location_price_overrides_restrictive ON location_price_overrides
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: availability_rules
ALTER TABLE availability_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY availability_rules_permissive ON availability_rules
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY availability_rules_restrictive ON availability_rules
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: areas
ALTER TABLE areas ENABLE ROW LEVEL SECURITY;
CREATE POLICY areas_permissive ON areas
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY areas_restrictive ON areas
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: tables
ALTER TABLE tables ENABLE ROW LEVEL SECURITY;
CREATE POLICY tables_permissive ON tables
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY tables_restrictive ON tables
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: sections
ALTER TABLE sections ENABLE ROW LEVEL SECURITY;
CREATE POLICY sections_permissive ON sections
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY sections_restrictive ON sections
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: visits
ALTER TABLE visits ENABLE ROW LEVEL SECURITY;
CREATE POLICY visits_permissive ON visits
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY visits_restrictive ON visits
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: accounts
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_permissive ON accounts
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY accounts_restrictive ON accounts
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: orders
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_permissive ON orders
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY orders_restrictive ON orders
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: order_lines
ALTER TABLE order_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY order_lines_permissive ON order_lines
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY order_lines_restrictive ON order_lines
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: order_line_modifiers
ALTER TABLE order_line_modifiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY order_line_modifiers_permissive ON order_line_modifiers
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY order_line_modifiers_restrictive ON order_line_modifiers
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: payments
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY payments_permissive ON payments
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY payments_restrictive ON payments
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: cancellations_and_voids
ALTER TABLE cancellations_and_voids ENABLE ROW LEVEL SECURITY;
CREATE POLICY cancellations_and_voids_permissive ON cancellations_and_voids
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY cancellations_and_voids_restrictive ON cancellations_and_voids
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: refunds
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY refunds_permissive ON refunds
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY refunds_restrictive ON refunds
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: outbox_events
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY outbox_events_permissive ON outbox_events
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY outbox_events_restrictive ON outbox_events
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

-- Table: audit_events
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_events_permissive ON audit_events
    AS PERMISSIVE FOR ALL TO application_runtime_role USING (true);
CREATE POLICY audit_events_restrictive ON audit_events
    AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);
