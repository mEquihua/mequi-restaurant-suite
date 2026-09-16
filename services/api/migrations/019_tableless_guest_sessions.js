export const up = (pgm) => {
  pgm.sql(`
ALTER TABLE guest_sessions ALTER COLUMN table_id DROP NOT NULL;
`);
};
