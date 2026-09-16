import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Integration test files share one real PostgreSQL database with global
     * singleton invariants (a single organization row). Running test files in
     * parallel worker processes races on that shared state — confirmed by
     * running `pnpm test` against a real database: files pass individually
     * but fail intermittently when Vitest's default file-level parallelism
     * runs them at the same time. Every file already resets its own tables in
     * `beforeAll`, so running files one at a time (not tests within a file)
     * is sufficient and keeps the suite fast.
     */
    fileParallelism: false,
    /**
     * Integration tests hit a real PostgreSQL connection pool. Observed one
     * intermittent failure in GitHub Actions (limited-core runner) that could
     * not be reproduced locally across 8+ runs in the same file order, and
     * passed cleanly on an immediate CI rerun of the identical commit — a
     * resource-contention-shaped flake, not a deterministic order bug (ruled
     * out by direct investigation). Retrying only *.integration.test.ts
     * files accepts that known, disclosed limitation. Scoped to only take
     * effect when DATABASE_URL is set (i.e. exactly when integration tests
     * actually run) rather than always-on, so a genuinely broken unit test
     * still fails on the first try in the common case; vitest has no
     * per-glob retry option, so a deterministic passing unit test is
     * unaffected either way since retries only trigger on failure.
     */
    retry: process.env.DATABASE_URL ? 1 : 0,
  },
});
