export const up = (pgm) => {
  pgm.sql(`
CREATE TABLE ingredients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name VARCHAR NOT NULL,
    unit_of_measure VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ingredients_organization_id ON ingredients(organization_id);
CREATE TRIGGER set_updated_at_ingredients BEFORE UPDATE ON ingredients FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ingredient_stock (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES locations(id),
    ingredient_id UUID NOT NULL REFERENCES ingredients(id),
    quantity_on_hand DECIMAL(12,4) NOT NULL DEFAULT 0,
    low_stock_threshold DECIMAL(12,4),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(location_id, ingredient_id)
);
CREATE INDEX idx_ingredient_stock_location_id ON ingredient_stock(location_id);
CREATE INDEX idx_ingredient_stock_ingredient_id ON ingredient_stock(ingredient_id);
CREATE TRIGGER set_updated_at_ingredient_stock BEFORE UPDATE ON ingredient_stock FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE recipe_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    product_id UUID REFERENCES products(id),
    variant_id UUID REFERENCES product_variants(id),
    modifier_id UUID REFERENCES modifiers(id),
    ingredient_id UUID NOT NULL REFERENCES ingredients(id),
    quantity_per_unit DECIMAL(12,4) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((product_id IS NOT NULL) <> (modifier_id IS NOT NULL))
);
CREATE INDEX idx_recipe_lines_organization_id ON recipe_lines(organization_id);
CREATE INDEX idx_recipe_lines_product_id ON recipe_lines(product_id);
CREATE INDEX idx_recipe_lines_modifier_id ON recipe_lines(modifier_id);
CREATE INDEX idx_recipe_lines_ingredient_id ON recipe_lines(ingredient_id);
CREATE TRIGGER set_updated_at_recipe_lines BEFORE UPDATE ON recipe_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE stock_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES locations(id),
    ingredient_id UUID NOT NULL REFERENCES ingredients(id),
    staff_id UUID NOT NULL REFERENCES staff(id),
    quantity_delta DECIMAL(12,4) NOT NULL,
    reason VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_stock_adjustments_location_id ON stock_adjustments(location_id);
CREATE INDEX idx_stock_adjustments_ingredient_id ON stock_adjustments(ingredient_id);

DO $$ DECLARE tbl text; BEGIN FOREACH tbl IN ARRAY ARRAY['ingredient_stock','stock_adjustments'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl); EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true)', tbl || '_permissive', tbl); EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO application_runtime_role USING (location_id = NULLIF(current_setting(''app.current_location_id'', true), '''')::uuid) WITH CHECK (location_id = NULLIF(current_setting(''app.current_location_id'', true), '''')::uuid)', tbl || '_restrictive', tbl); END LOOP; END $$;
`);
};
