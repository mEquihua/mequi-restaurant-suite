export const up = (pgm) => {
  pgm.sql(`
CREATE TABLE scheduled_order_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL UNIQUE REFERENCES locations(id),
  accepts_scheduled_orders BOOLEAN NOT NULL DEFAULT false,
  minimum_lead_time_minutes INTEGER NOT NULL DEFAULT 60,
  maximum_lead_time_days INTEGER NOT NULL DEFAULT 7,
  operating_hours JSONB NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at_scheduled_order_settings BEFORE UPDATE ON scheduled_order_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE scheduled_order_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY scheduled_order_settings_permissive ON scheduled_order_settings AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY scheduled_order_settings_restrictive ON scheduled_order_settings AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)
    WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);
`);
};
