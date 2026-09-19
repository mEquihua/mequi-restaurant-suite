// Structured, server-authoritative terminal application profiles.
export const up = (pgm) => {
  pgm.sql(`
ALTER TABLE terminals
  ADD COLUMN app_target VARCHAR NULL
    CHECK (app_target IS NULL OR app_target IN ('KITCHEN', 'SELF_SERVICE', 'STAFF')),
  ADD COLUMN profile_config JSONB NULL;
`);
};
