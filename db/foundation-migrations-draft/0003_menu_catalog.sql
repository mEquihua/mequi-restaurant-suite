-- Creates menu and catalog tables.
-- Deviation: Added updated_at trigger for all tables.

CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name VARCHAR NOT NULL,
    description TEXT,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_categories_organization_id ON categories(organization_id);

CREATE TRIGGER set_updated_at_categories
BEFORE UPDATE ON categories
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    category_id UUID REFERENCES categories(id),
    name VARCHAR NOT NULL,
    internal_name VARCHAR,
    description TEXT,
    base_price INTEGER NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_products_organization_id ON products(organization_id);
CREATE INDEX idx_products_category_id ON products(category_id);

CREATE TRIGGER set_updated_at_products
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id),
    name VARCHAR NOT NULL,
    price_adjustment INTEGER NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_product_variants_product_id ON product_variants(product_id);

CREATE TRIGGER set_updated_at_product_variants
BEFORE UPDATE ON product_variants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE modifier_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name VARCHAR NOT NULL,
    min_selections INTEGER NOT NULL DEFAULT 0,
    max_selections INTEGER,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_modifier_groups_organization_id ON modifier_groups(organization_id);

CREATE TRIGGER set_updated_at_modifier_groups
BEFORE UPDATE ON modifier_groups
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE product_modifier_groups (
    product_id UUID NOT NULL REFERENCES products(id),
    modifier_group_id UUID NOT NULL REFERENCES modifier_groups(id),
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (product_id, modifier_group_id)
);

CREATE INDEX idx_product_modifier_groups_modifier_group_id ON product_modifier_groups(modifier_group_id);

CREATE TRIGGER set_updated_at_product_modifier_groups
BEFORE UPDATE ON product_modifier_groups
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE modifiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    modifier_group_id UUID NOT NULL REFERENCES modifier_groups(id),
    name VARCHAR NOT NULL,
    price_adjustment INTEGER NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_modifiers_modifier_group_id ON modifiers(modifier_group_id);

CREATE TRIGGER set_updated_at_modifiers
BEFORE UPDATE ON modifiers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE product_combo_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id),
    name VARCHAR NOT NULL,
    min_selections INTEGER NOT NULL DEFAULT 1,
    max_selections INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_product_combo_groups_product_id ON product_combo_groups(product_id);

CREATE TRIGGER set_updated_at_product_combo_groups
BEFORE UPDATE ON product_combo_groups
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE product_combo_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    combo_group_id UUID NOT NULL REFERENCES product_combo_groups(id),
    product_id UUID NOT NULL REFERENCES products(id),
    price_adjustment INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_product_combo_items_combo_group_id ON product_combo_items(combo_group_id);
CREATE INDEX idx_product_combo_items_product_id ON product_combo_items(product_id);

CREATE TRIGGER set_updated_at_product_combo_items
BEFORE UPDATE ON product_combo_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE location_price_overrides (
    location_id UUID NOT NULL REFERENCES locations(id),
    product_id UUID NOT NULL REFERENCES products(id),
    override_price INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (location_id, product_id)
);

CREATE INDEX idx_location_price_overrides_product_id ON location_price_overrides(product_id);
CREATE INDEX idx_location_price_overrides_location_id ON location_price_overrides(location_id);

CREATE TRIGGER set_updated_at_location_price_overrides
BEFORE UPDATE ON location_price_overrides
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE availability_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES locations(id),
    product_id UUID NOT NULL REFERENCES products(id),
    status VARCHAR NOT NULL,
    channel_scope VARCHAR,
    service_type_scope VARCHAR,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_availability_status CHECK (status IN ('AVAILABLE', 'EXHAUSTED', 'HIDDEN', 'SCHEDULED'))
);

CREATE INDEX idx_availability_rules_location_id ON availability_rules(location_id);
CREATE INDEX idx_availability_rules_product_id ON availability_rules(product_id);

CREATE TRIGGER set_updated_at_availability_rules
BEFORE UPDATE ON availability_rules
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
