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
  },
});
