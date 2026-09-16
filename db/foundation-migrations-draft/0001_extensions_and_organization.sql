-- Creates core extensions, trigger function for updated_at, organizations, locations, and config.
-- Note: Trigger approach selected for updated_at consistency across all tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR NOT NULL,
    is_single_org BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_is_single_org CHECK (is_single_org IS TRUE),
    CONSTRAINT unq_is_single_org UNIQUE (is_single_org)
);

CREATE TRIGGER set_updated_at_organizations
BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name VARCHAR NOT NULL,
    address TEXT,
    timezone VARCHAR NOT NULL DEFAULT 'UTC',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_locations_organization_id ON locations(organization_id);

CREATE TRIGGER set_updated_at_locations
BEFORE UPDATE ON locations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE location_operating_config (
    location_id UUID PRIMARY KEY REFERENCES locations(id),
    config_json JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary key automatically creates an index, but an explicit index on location_id for RLS is standard.
-- We can skip creating a separate index on location_id here since it's the PK.

CREATE TRIGGER set_updated_at_location_operating_config
BEFORE UPDATE ON location_operating_config
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
