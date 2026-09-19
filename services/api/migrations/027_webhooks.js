export const up = (pgm) => {
  pgm.sql(`
CREATE TABLE webhook_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    url VARCHAR NOT NULL,
    event_types VARCHAR[] NOT NULL,
    secret VARCHAR NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_webhook_subscriptions_organization_id ON webhook_subscriptions(organization_id);
CREATE TRIGGER set_updated_at_webhook_subscriptions BEFORE UPDATE ON webhook_subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE outbox_events ADD COLUMN webhook_dispatched_at TIMESTAMPTZ;

GRANT SELECT ON webhook_subscriptions TO application_worker_role;
GRANT SELECT, UPDATE ON outbox_events TO application_worker_role;
GRANT SELECT ON locations TO application_worker_role;
  `);
};
