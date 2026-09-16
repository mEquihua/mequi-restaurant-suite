export const up = (pgm) => {
  pgm.sql(`
CREATE TABLE module_definitions (
    key TEXT PRIMARY KEY,
    display_name VARCHAR NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER set_updated_at_module_definitions BEFORE UPDATE ON module_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO module_definitions (key, display_name, description) VALUES
    ('pos', 'Caja / POS', 'Toma y cobro de pedidos en punto de venta.'),
    ('table_service', 'Servicio en mesa', 'Operación de mesas y atención en salón.'),
    ('kitchen_display', 'Kitchen Display', 'Visualización y preparación de comandas en cocina.'),
    ('qr_ordering', 'QR Ordering', 'Pedidos del cliente desde un código QR.'),
    ('kiosk', 'Kiosk', 'Autoservicio desde un dispositivo en el restaurante.'),
    ('online_ordering', 'Online Ordering', 'Pedidos desde el canal digital del restaurante.'),
    ('pickup', 'Pickup', 'Pedidos para recoger.'),
    ('delivery', 'Delivery', 'Pedidos para entrega.'),
    ('reservations', 'Reservaciones', 'Reservas y gestión de disponibilidad de mesas.'),
    ('loyalty', 'Loyalty', 'Programa de fidelidad y recompensas.'),
    ('inventory', 'Inventario', 'Control de existencias e insumos.')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE module_activations (
    location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    module_key TEXT NOT NULL REFERENCES module_definitions(key),
    status VARCHAR NOT NULL DEFAULT 'DISABLED',
    attention_reason TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (location_id, module_key),
    CONSTRAINT chk_module_activation_status CHECK (status IN ('DISABLED', 'PENDING_CONFIGURATION', 'READY', 'ACTIVE', 'PAUSED', 'NEEDS_ATTENTION')),
    CONSTRAINT chk_module_activation_attention_reason CHECK (status <> 'NEEDS_ATTENTION' OR attention_reason IS NOT NULL)
);
CREATE INDEX idx_module_activations_location_id ON module_activations(location_id);
CREATE TRIGGER set_updated_at_module_activations BEFORE UPDATE ON module_activations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE module_activations ENABLE ROW LEVEL SECURITY;
CREATE POLICY module_activations_permissive ON module_activations AS PERMISSIVE FOR ALL TO application_runtime_role USING (true) WITH CHECK (true);
CREATE POLICY module_activations_restrictive ON module_activations AS RESTRICTIVE FOR ALL TO application_runtime_role
    USING (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid)
    WITH CHECK (location_id = NULLIF(current_setting('app.current_location_id', true), '')::uuid);
`);
};
