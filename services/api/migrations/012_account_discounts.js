export const up = (pgm) => {
  pgm.sql(`
CREATE TABLE account_discounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  order_line_id UUID REFERENCES order_lines(id),
  discount_type VARCHAR NOT NULL CHECK (discount_type IN ('PERCENTAGE', 'AMOUNT')),
  value INTEGER NOT NULL CHECK (value > 0),
  computed_amount INTEGER NOT NULL CHECK (computed_amount >= 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  applied_by UUID NOT NULL REFERENCES staff(id),
  is_override BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_account_discount_percentage_value
    CHECK (discount_type <> 'PERCENTAGE' OR value <= 100)
);
CREATE INDEX idx_account_discounts_location_id ON account_discounts(location_id);
CREATE INDEX idx_account_discounts_account_id ON account_discounts(account_id);
ALTER TABLE account_discounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_discounts_permissive ON account_discounts
  AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY account_discounts_restrictive ON account_discounts
  AS RESTRICTIVE FOR ALL TO application_runtime_role
  USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)
  WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);
`);
};
