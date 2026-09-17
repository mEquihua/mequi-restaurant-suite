export const up = (pgm) => {
  pgm.sql(`
CREATE TABLE reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES locations(id),
    customer_id UUID REFERENCES customers(id),
    party_size INTEGER NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reservation_time TIMESTAMPTZ NOT NULL,
    status VARCHAR NOT NULL,
    customer_name VARCHAR NOT NULL,
    customer_email VARCHAR,
    customer_phone VARCHAR,
    special_requests TEXT,
    visit_id UUID REFERENCES visits(id),
    guest_token_hash VARCHAR,
    confirmed_by_staff_id UUID REFERENCES staff(id),
    cancelled_by_staff_id UUID REFERENCES staff(id),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_reservation_status CHECK (status IN ('REQUESTED', 'CONFIRMED', 'ARRIVED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'))
);
CREATE INDEX idx_reservations_location_id ON reservations(location_id);
CREATE INDEX idx_reservations_customer_id ON reservations(customer_id);
CREATE INDEX idx_reservations_visit_id ON reservations(visit_id);
CREATE TRIGGER set_updated_at_reservations BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE reservation_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL UNIQUE REFERENCES locations(id),
    accepts_reservations BOOLEAN NOT NULL DEFAULT FALSE,
    operating_hours JSONB NOT NULL DEFAULT '[]',
    estimated_visit_duration_minutes INTEGER NOT NULL DEFAULT 90,
    minimum_lead_time_minutes INTEGER NOT NULL DEFAULT 60,
    maximum_party_size INTEGER NOT NULL DEFAULT 8,
    auto_confirm BOOLEAN NOT NULL DEFAULT FALSE,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_reservation_settings_location_id ON reservation_settings(location_id);
CREATE TRIGGER set_updated_at_reservation_settings BEFORE UPDATE ON reservation_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['reservations','reservation_settings'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl); EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true)', tbl || '_permissive', tbl); EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO application_runtime_role USING (location_id = NULLIF(current_setting(''app.current_location_id'', true), '''')::uuid) WITH CHECK (location_id = NULLIF(current_setting(''app.current_location_id'', true), '''')::uuid)', tbl || '_restrictive', tbl); END LOOP; END $$;
`);
};
