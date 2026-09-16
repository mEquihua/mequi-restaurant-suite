export const up = (pgm) => {
  pgm.sql(`
ALTER TABLE delivery_zones ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE order_fulfillments ADD COLUMN delivery_zone_id UUID REFERENCES delivery_zones(id);
ALTER TABLE order_fulfillments ADD COLUMN delivery_fee INTEGER NOT NULL DEFAULT 0;
`);
};
