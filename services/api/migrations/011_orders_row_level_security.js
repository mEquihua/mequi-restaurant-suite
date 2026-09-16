export const up = (pgm) => {
  pgm.sql(`
DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['visits','accounts','orders','order_lines','order_line_modifiers','payments','cancellations_and_voids','refunds','outbox_events','audit_events','command_idempotency'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl); EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true)', tbl || '_permissive', tbl); EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO application_runtime_role USING (location_id = NULLIF(current_setting(''app.current_location_id'', true), '''')::uuid) WITH CHECK (location_id = NULLIF(current_setting(''app.current_location_id'', true), '''')::uuid)', tbl || '_restrictive', tbl); END LOOP; END $$;
`);
};
