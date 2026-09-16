export const up = (pgm) => {
  pgm.sql(`
CREATE TABLE guest_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  visit_id UUID NOT NULL REFERENCES visits(id),
  table_id UUID NOT NULL REFERENCES tables(id),
  token_hash VARCHAR NOT NULL UNIQUE,
  device_info VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_guest_sessions_location_id ON guest_sessions(location_id);
CREATE INDEX idx_guest_sessions_visit_id ON guest_sessions(visit_id);
CREATE INDEX idx_guest_sessions_table_id ON guest_sessions(table_id);

CREATE TABLE table_service_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  visit_id UUID NOT NULL REFERENCES visits(id),
  table_id UUID NOT NULL REFERENCES tables(id),
  request_type VARCHAR NOT NULL CHECK (request_type IN ('CALL_WAITER', 'REQUEST_BILL', 'NEED_WATER', 'NEED_UTENSILS')),
  status VARCHAR NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RESOLVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by_staff_id UUID REFERENCES staff(id)
);
CREATE INDEX idx_table_service_requests_location_id ON table_service_requests(location_id);
CREATE INDEX idx_table_service_requests_visit_id ON table_service_requests(visit_id);

ALTER TABLE guest_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY guest_sessions_permissive ON guest_sessions AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY guest_sessions_restrictive ON guest_sessions AS RESTRICTIVE FOR ALL TO application_runtime_role
  USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)
  WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);
ALTER TABLE table_service_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY table_service_requests_permissive ON table_service_requests AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY table_service_requests_restrictive ON table_service_requests AS RESTRICTIVE FOR ALL TO application_runtime_role
  USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)
  WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

ALTER TABLE module_activations ADD COLUMN guest_payment_mode VARCHAR NOT NULL DEFAULT 'ORDER_ONLY'
  CHECK (guest_payment_mode IN ('ORDER_ONLY', 'REQUEST_BILL', 'ORDER_AND_PAY'));
`);
};
