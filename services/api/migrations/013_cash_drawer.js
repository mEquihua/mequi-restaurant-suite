export const up = (pgm) => {
  pgm.sql(`
CREATE TABLE cash_drawer_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  terminal_id UUID NOT NULL REFERENCES terminals(id),
  opened_by UUID NOT NULL REFERENCES staff(id),
  opening_float INTEGER NOT NULL CHECK (opening_float >= 0),
  status VARCHAR NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by UUID REFERENCES staff(id),
  closed_at TIMESTAMPTZ,
  counted_amount INTEGER,
  expected_amount INTEGER,
  variance INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_cash_drawer_sessions_open_terminal
  ON cash_drawer_sessions(terminal_id) WHERE status = 'OPEN';
CREATE INDEX idx_cash_drawer_sessions_location ON cash_drawer_sessions(location_id);

CREATE TABLE cash_drawer_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  drawer_session_id UUID NOT NULL REFERENCES cash_drawer_sessions(id),
  movement_type VARCHAR NOT NULL CHECK (movement_type IN ('CASH_IN', 'CASH_OUT')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  recorded_by UUID NOT NULL REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_cash_drawer_movements_session ON cash_drawer_movements(drawer_session_id);
CREATE INDEX idx_cash_drawer_movements_location ON cash_drawer_movements(location_id);

ALTER TABLE cash_drawer_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY cash_drawer_sessions_permissive ON cash_drawer_sessions
  AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY cash_drawer_sessions_restrictive ON cash_drawer_sessions
  AS RESTRICTIVE FOR ALL TO application_runtime_role
  USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)
  WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

ALTER TABLE cash_drawer_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY cash_drawer_movements_permissive ON cash_drawer_movements
  AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY cash_drawer_movements_restrictive ON cash_drawer_movements
  AS RESTRICTIVE FOR ALL TO application_runtime_role
  USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)
  WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);
`);
};
