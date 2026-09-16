export const up = (pgm) => {
  pgm.sql(`
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  email VARCHAR NOT NULL,
  password_hash VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  phone VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, email)
);
CREATE INDEX idx_customers_organization_id ON customers(organization_id);

CREATE TABLE customer_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  token_hash VARCHAR NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_customer_sessions_organization_id ON customer_sessions(organization_id);
CREATE INDEX idx_customer_sessions_customer_id ON customer_sessions(customer_id);

CREATE TABLE delivery_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  name VARCHAR NOT NULL,
  fee INTEGER NOT NULL,
  minimum_order_amount INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_delivery_zones_location_id ON delivery_zones(location_id);

CREATE TABLE order_fulfillments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
  fulfillment_type VARCHAR NOT NULL CHECK (fulfillment_type IN ('PICKUP', 'DELIVERY')),
  status VARCHAR NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED')),
  scheduled_for TIMESTAMPTZ,
  customer_name VARCHAR NOT NULL,
  customer_email VARCHAR NOT NULL,
  customer_phone VARCHAR NOT NULL,
  delivery_address JSONB,
  delivery_driver_name VARCHAR,
  guest_token_hash VARCHAR,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_order_fulfillments_location_id ON order_fulfillments(location_id);

ALTER TABLE visits ADD COLUMN customer_id UUID REFERENCES customers(id);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY customers_permissive ON customers AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY customers_restrictive ON customers AS RESTRICTIVE FOR ALL TO application_runtime_role
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE customer_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_sessions_permissive ON customer_sessions AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY customer_sessions_restrictive ON customer_sessions AS RESTRICTIVE FOR ALL TO application_runtime_role
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE delivery_zones ENABLE ROW LEVEL SECURITY;
CREATE POLICY delivery_zones_permissive ON delivery_zones AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY delivery_zones_restrictive ON delivery_zones AS RESTRICTIVE FOR ALL TO application_runtime_role
  USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)
  WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);

ALTER TABLE order_fulfillments ENABLE ROW LEVEL SECURITY;
CREATE POLICY order_fulfillments_permissive ON order_fulfillments AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY order_fulfillments_restrictive ON order_fulfillments AS RESTRICTIVE FOR ALL TO application_runtime_role
  USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)
  WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);
`);
};
