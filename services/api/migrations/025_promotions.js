export const up = (pgm) => {
  pgm.sql(`
CREATE TABLE promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR NOT NULL,
  description TEXT,
  discount_type VARCHAR NOT NULL CHECK (discount_type IN ('PERCENTAGE', 'AMOUNT')),
  discount_value INTEGER NOT NULL,
  category_id UUID REFERENCES categories(id),
  product_id UUID REFERENCES products(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  days_of_week INTEGER[],
  start_time TIME,
  end_time TIME,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_discount_percentage_value CHECK (discount_type <> 'PERCENTAGE' OR discount_value <= 100),
  CONSTRAINT chk_target_scope CHECK (category_id IS NULL OR product_id IS NULL)
);
CREATE INDEX idx_promotions_organization_id ON promotions(organization_id);
CREATE TRIGGER set_updated_at_promotions BEFORE UPDATE ON promotions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE order_line_promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  order_line_id UUID NOT NULL UNIQUE REFERENCES order_lines(id),
  promotion_id UUID NOT NULL REFERENCES promotions(id),
  computed_amount INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_order_line_promotions_location_id ON order_line_promotions(location_id);
CREATE INDEX idx_order_line_promotions_order_line_id ON order_line_promotions(order_line_id);

ALTER TABLE order_line_promotions ENABLE ROW LEVEL SECURITY;
CREATE POLICY order_line_promotions_permissive ON order_line_promotions AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY order_line_promotions_restrictive ON order_line_promotions AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)
    WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);
  `);
};
