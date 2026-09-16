// Least-privilege role for the background outbox dispatcher (services/worker).
// It must read and mark outbox_events across every location, which requires
// bypassing the runtime role's location-scoped RLS policies, but it has no
// legitimate need for the broad ALL-PRIVILEGES-on-everything access that
// application_migration_role holds for schema migrations. Reusing the
// migration role for a continuously-running production process would give a
// bug or compromise in the worker full read/write access to every table
// (including staff.pin_hash) instead of just the one table it actually
// touches.
export const up = (pgm) => {
  pgm.sql(`
DO $$ BEGIN
    CREATE ROLE application_worker_role NOLOGIN BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    EXECUTE format('GRANT application_worker_role TO %I', current_user);
END $$;

GRANT USAGE ON SCHEMA public TO application_worker_role;
GRANT SELECT, UPDATE ON outbox_events TO application_worker_role;
`);
};
