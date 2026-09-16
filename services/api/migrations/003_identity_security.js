// Security state required by the enrolled-device and opaque-session protocol.
export const up = (pgm) => {
  pgm.sql(`
ALTER TABLE terminals ADD COLUMN credential_hash VARCHAR NOT NULL;
ALTER TABLE staff_sessions ADD COLUMN revoked_at TIMESTAMPTZ;
ALTER TABLE staff_sessions ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX unq_staff_sessions_token_hash ON staff_sessions(token_hash);

CREATE TABLE terminal_pin_attempts (
    terminal_id UUID NOT NULL REFERENCES terminals(id),
    credential_fingerprint CHAR(64) NOT NULL,
    failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    next_attempt_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (terminal_id, credential_fingerprint)
);
CREATE INDEX idx_terminal_pin_attempts_next_attempt_at ON terminal_pin_attempts(next_attempt_at);
CREATE TRIGGER set_updated_at_terminal_pin_attempts
BEFORE UPDATE ON terminal_pin_attempts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`);
};
