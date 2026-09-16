// Adapted verbatim from db/foundation-migrations-draft/0002_identity.sql.
export const up = (pgm) => {
  pgm.sql(`
CREATE TABLE staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    first_name VARCHAR NOT NULL,
    last_name VARCHAR NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    pin_hash VARCHAR NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_staff_organization_id ON staff(organization_id);
CREATE TRIGGER set_updated_at_staff BEFORE UPDATE ON staff FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name VARCHAR NOT NULL,
    description TEXT,
    is_system_template BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_roles_organization_id ON roles(organization_id);
CREATE TRIGGER set_updated_at_roles BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE role_permissions (
    role_id UUID NOT NULL REFERENCES roles(id),
    permission_name VARCHAR NOT NULL,
    scope VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (role_id, permission_name)
);
CREATE INDEX idx_role_permissions_role_id ON role_permissions(role_id);
CREATE TRIGGER set_updated_at_role_permissions BEFORE UPDATE ON role_permissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE staff_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL REFERENCES staff(id),
    role_id UUID NOT NULL REFERENCES roles(id),
    location_id UUID REFERENCES locations(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unq_staff_roles UNIQUE NULLS NOT DISTINCT (staff_id, role_id, location_id)
);
CREATE INDEX idx_staff_roles_staff_id ON staff_roles(staff_id);
CREATE INDEX idx_staff_roles_role_id ON staff_roles(role_id);
CREATE INDEX idx_staff_roles_location_id ON staff_roles(location_id);
CREATE TRIGGER set_updated_at_staff_roles BEFORE UPDATE ON staff_roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE terminals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES locations(id),
    name VARCHAR NOT NULL,
    device_profile VARCHAR,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_terminals_location_id ON terminals(location_id);
CREATE TRIGGER set_updated_at_terminals BEFORE UPDATE ON terminals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE staff_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL REFERENCES staff(id),
    location_id UUID NOT NULL REFERENCES locations(id),
    terminal_id UUID NOT NULL REFERENCES terminals(id),
    token_hash VARCHAR NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_staff_sessions_staff_id ON staff_sessions(staff_id);
CREATE INDEX idx_staff_sessions_location_id ON staff_sessions(location_id);
CREATE INDEX idx_staff_sessions_terminal_id ON staff_sessions(terminal_id);
CREATE TRIGGER set_updated_at_staff_sessions BEFORE UPDATE ON staff_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`);
};
