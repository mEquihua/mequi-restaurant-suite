-- Creates orders, visits, accounts, payments, and refund/void tables.
-- Corrections Applied: Added CHECK for orders.order_type and payments.method.

CREATE TABLE visits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES locations(id),
    table_id UUID REFERENCES tables(id),
    staff_id UUID REFERENCES staff(id),
    guest_count INTEGER,
    status VARCHAR NOT NULL DEFAULT 'OPEN',
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_visit_status CHECK (status IN ('OPEN', 'COMPLETED', 'CANCELLED'))
);

CREATE INDEX idx_visits_location_id ON visits(location_id);
CREATE INDEX idx_visits_table_id ON visits(table_id);
CREATE INDEX idx_visits_staff_id ON visits(staff_id);

CREATE TRIGGER set_updated_at_visits
BEFORE UPDATE ON visits
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES locations(id),
    visit_id UUID NOT NULL REFERENCES visits(id),
    name VARCHAR,
    status VARCHAR NOT NULL DEFAULT 'OPEN',
    subtotal INTEGER NOT NULL DEFAULT 0,
    tax INTEGER NOT NULL DEFAULT 0,
    discount INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    paid_amount INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_account_status CHECK (status IN ('OPEN', 'PARTIALLY_PAID', 'PAID', 'CLOSED', 'REFUNDED')),
    CONSTRAINT chk_account_subtotal CHECK (subtotal >= 0),
    CONSTRAINT chk_account_tax CHECK (tax >= 0),
    CONSTRAINT chk_account_total CHECK (total >= 0),
    CONSTRAINT chk_account_paid_amount CHECK (paid_amount >= 0)
);

CREATE INDEX idx_accounts_location_id ON accounts(location_id);
CREATE INDEX idx_accounts_visit_id ON accounts(visit_id);

CREATE TRIGGER set_updated_at_accounts
BEFORE UPDATE ON accounts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES locations(id),
    visit_id UUID NOT NULL REFERENCES visits(id),
    order_type VARCHAR NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'DRAFT',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_order_status CHECK (status IN ('DRAFT', 'CONFIRMED', 'HELD', 'SENT', 'PREPARING', 'READY', 'FULFILLED', 'COMPLETED', 'CANCELLED', 'REJECTED')),
    CONSTRAINT chk_order_type CHECK (order_type IN ('DINE_IN', 'TAKEOUT', 'PICKUP', 'DELIVERY', 'TABLE_SELF_ORDER'))
);

CREATE INDEX idx_orders_location_id ON orders(location_id);
CREATE INDEX idx_orders_visit_id ON orders(visit_id);

CREATE TRIGGER set_updated_at_orders
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE order_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES locations(id),
    order_id UUID NOT NULL REFERENCES orders(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    product_id UUID NOT NULL REFERENCES products(id),
    variant_id UUID REFERENCES product_variants(id),
    seat_number INTEGER,
    course_name VARCHAR,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price INTEGER NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'DRAFT',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_order_line_status CHECK (status IN ('DRAFT', 'CONFIRMED', 'HELD', 'SENT', 'PREPARING', 'READY', 'FULFILLED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'VOIDED'))
);

CREATE INDEX idx_order_lines_location_id ON order_lines(location_id);
CREATE INDEX idx_order_lines_order_id ON order_lines(order_id);
CREATE INDEX idx_order_lines_account_id ON order_lines(account_id);
CREATE INDEX idx_order_lines_product_id ON order_lines(product_id);
CREATE INDEX idx_order_lines_variant_id ON order_lines(variant_id);

CREATE TRIGGER set_updated_at_order_lines
BEFORE UPDATE ON order_lines
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE order_line_modifiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES locations(id),
    order_line_id UUID NOT NULL REFERENCES order_lines(id),
    modifier_id UUID NOT NULL REFERENCES modifiers(id),
    unit_price INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_line_modifiers_location_id ON order_line_modifiers(location_id);
CREATE INDEX idx_order_line_modifiers_order_line_id ON order_line_modifiers(order_line_id);
CREATE INDEX idx_order_line_modifiers_modifier_id ON order_line_modifiers(modifier_id);

CREATE TRIGGER set_updated_at_order_line_modifiers
BEFORE UPDATE ON order_line_modifiers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES locations(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    method VARCHAR NOT NULL,
    amount INTEGER NOT NULL,
    tip_amount INTEGER NOT NULL DEFAULT 0,
    status VARCHAR NOT NULL,
    reference_code VARCHAR,
    idempotency_key VARCHAR,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_payment_amount CHECK (amount >= 0),
    CONSTRAINT chk_payment_method CHECK (method IN ('CASH', 'CARD', 'TRANSFER', 'OTHER')),
    CONSTRAINT unq_payment_idempotency_key UNIQUE (idempotency_key)
);

CREATE INDEX idx_payments_location_id ON payments(location_id);
CREATE INDEX idx_payments_account_id ON payments(account_id);

CREATE TRIGGER set_updated_at_payments
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE cancellations_and_voids (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES locations(id),
    order_line_id UUID NOT NULL REFERENCES order_lines(id),
    operation_type VARCHAR NOT NULL,
    amount INTEGER NOT NULL,
    reason VARCHAR NOT NULL,
    authorized_by UUID NOT NULL REFERENCES staff(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_cv_operation_type CHECK (operation_type IN ('VOID', 'CANCEL'))
);

CREATE INDEX idx_cancellations_location_id ON cancellations_and_voids(location_id);
CREATE INDEX idx_cancellations_order_line_id ON cancellations_and_voids(order_line_id);
CREATE INDEX idx_cancellations_authorized_by ON cancellations_and_voids(authorized_by);

CREATE TRIGGER set_updated_at_cancellations_and_voids
BEFORE UPDATE ON cancellations_and_voids
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES locations(id),
    payment_id UUID NOT NULL REFERENCES payments(id),
    amount INTEGER NOT NULL,
    reason VARCHAR NOT NULL,
    authorized_by UUID NOT NULL REFERENCES staff(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refunds_location_id ON refunds(location_id);
CREATE INDEX idx_refunds_payment_id ON refunds(payment_id);
CREATE INDEX idx_refunds_authorized_by ON refunds(authorized_by);

CREATE TRIGGER set_updated_at_refunds
BEFORE UPDATE ON refunds
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
