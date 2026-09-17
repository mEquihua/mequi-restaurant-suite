export const up = (pgm) => {
  pgm.sql(`
CREATE TABLE loyalty_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id),
  spend_amount_for_one_point INTEGER NOT NULL DEFAULT 1000,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER set_updated_at_loyalty_settings BEFORE UPDATE ON loyalty_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE loyalty_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  points_balance INTEGER NOT NULL DEFAULT 0,
  total_visits INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, customer_id)
);
CREATE INDEX idx_loyalty_accounts_organization_id ON loyalty_accounts(organization_id);
CREATE TRIGGER set_updated_at_loyalty_accounts BEFORE UPDATE ON loyalty_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE loyalty_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name VARCHAR NOT NULL,
  description TEXT,
  cost_in_points INTEGER,
  cost_in_visits INTEGER,
  discount_type VARCHAR NOT NULL CHECK (discount_type IN ('PERCENTAGE', 'AMOUNT')),
  discount_value INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_reward_cost CHECK (cost_in_points IS NOT NULL OR cost_in_visits IS NOT NULL),
  CONSTRAINT chk_reward_percentage_value CHECK (discount_type <> 'PERCENTAGE' OR discount_value <= 100)
);
CREATE INDEX idx_loyalty_rewards_organization_id ON loyalty_rewards(organization_id);
CREATE TRIGGER set_updated_at_loyalty_rewards BEFORE UPDATE ON loyalty_rewards FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE loyalty_coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  code VARCHAR NOT NULL UNIQUE,
  discount_type VARCHAR NOT NULL CHECK (discount_type IN ('PERCENTAGE', 'AMOUNT')),
  discount_value INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_coupon_percentage_value CHECK (discount_type <> 'PERCENTAGE' OR discount_value <= 100)
);
CREATE INDEX idx_loyalty_coupons_organization_id ON loyalty_coupons(organization_id);
CREATE TRIGGER set_updated_at_loyalty_coupons BEFORE UPDATE ON loyalty_coupons FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE loyalty_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  loyalty_account_id UUID NOT NULL REFERENCES loyalty_accounts(id),
  transaction_type VARCHAR NOT NULL CHECK (transaction_type IN ('ACCRUAL', 'REDEMPTION', 'ADJUSTMENT')),
  points_delta INTEGER NOT NULL,
  visit_count_delta INTEGER NOT NULL DEFAULT 0,
  reason VARCHAR NOT NULL,
  reference_visit_id UUID REFERENCES visits(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_loyalty_transactions_organization_id ON loyalty_transactions(organization_id);

CREATE TABLE loyalty_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  loyalty_account_id UUID REFERENCES loyalty_accounts(id),
  reward_id UUID REFERENCES loyalty_rewards(id),
  coupon_id UUID REFERENCES loyalty_coupons(id),
  account_discount_id UUID NOT NULL REFERENCES account_discounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_redemption_source CHECK (reward_id IS NOT NULL OR coupon_id IS NOT NULL)
);
CREATE INDEX idx_loyalty_redemptions_organization_id ON loyalty_redemptions(organization_id);

ALTER TABLE account_discounts ALTER COLUMN applied_by DROP NOT NULL;

DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['loyalty_accounts', 'loyalty_transactions', 'loyalty_redemptions'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl); EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true)', tbl || '_permissive', tbl); EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO application_runtime_role USING (organization_id = NULLIF(current_setting(''app.current_organization_id'', true), '''')::uuid) WITH CHECK (organization_id = NULLIF(current_setting(''app.current_organization_id'', true), '''')::uuid)', tbl || '_restrictive', tbl); END LOOP; END $$;
`);
};
