export const up = (pgm) => {
  pgm.sql(`
CREATE TABLE timeclock_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  staff_id UUID NOT NULL REFERENCES staff(id),
  status VARCHAR NOT NULL DEFAULT 'OPEN',
  clocked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  clocked_out_at TIMESTAMPTZ,
  clocked_in_by_staff_id UUID NOT NULL REFERENCES staff(id),
  clocked_out_by_staff_id UUID REFERENCES staff(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_timeclock_shifts_status CHECK (status IN ('OPEN', 'CLOSED'))
);

CREATE INDEX idx_timeclock_shifts_location_id ON timeclock_shifts(location_id);
CREATE INDEX idx_timeclock_shifts_staff_id ON timeclock_shifts(staff_id);

CREATE TRIGGER set_updated_at_timeclock_shifts BEFORE UPDATE ON timeclock_shifts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE timeclock_shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY timeclock_shifts_permissive ON timeclock_shifts AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY timeclock_shifts_restrictive ON timeclock_shifts AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)
    WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

INSERT INTO module_definitions (key, display_name, description) VALUES
    ('timeclock', 'Timeclock', 'Reloj checador y registro de turnos de empleados.')
ON CONFLICT (key) DO NOTHING;
`);
};
