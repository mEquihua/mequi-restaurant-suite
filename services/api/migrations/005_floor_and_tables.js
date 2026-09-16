// Adapted verbatim from db/foundation-migrations-draft/0004_floor_and_tables.sql.
export const up = (pgm) => {
  pgm.sql(`
CREATE TABLE areas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), location_id UUID NOT NULL REFERENCES locations(id), name VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_areas_location_id ON areas(location_id);
CREATE TRIGGER set_updated_at_areas BEFORE UPDATE ON areas FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), location_id UUID NOT NULL REFERENCES locations(id), area_id UUID NOT NULL REFERENCES areas(id), name VARCHAR NOT NULL,
    min_capacity INTEGER NOT NULL DEFAULT 1, max_capacity INTEGER NOT NULL, pos_x INTEGER NOT NULL DEFAULT 0, pos_y INTEGER NOT NULL DEFAULT 0,
    status VARCHAR NOT NULL DEFAULT 'AVAILABLE', version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_table_status CHECK (status IN ('AVAILABLE', 'OCCUPIED', 'NEEDS_CLEANING', 'OUT_OF_ORDER'))
);
CREATE INDEX idx_tables_location_id ON tables(location_id);
CREATE INDEX idx_tables_area_id ON tables(area_id);
CREATE TRIGGER set_updated_at_tables BEFORE UPDATE ON tables FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), location_id UUID NOT NULL REFERENCES locations(id), name VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sections_location_id ON sections(location_id);
CREATE TRIGGER set_updated_at_sections BEFORE UPDATE ON sections FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE table_sections (
    table_id UUID NOT NULL REFERENCES tables(id), section_id UUID NOT NULL REFERENCES sections(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (table_id, section_id)
);
CREATE INDEX idx_table_sections_section_id ON table_sections(section_id);
CREATE TRIGGER set_updated_at_table_sections BEFORE UPDATE ON table_sections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`);
};
