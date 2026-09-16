export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE categories ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  `);
};
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE categories DROP COLUMN version;
  `);
};
