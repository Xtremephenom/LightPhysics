/**
 * Vitest-compatible configuration reserved for the first package test suite.
 * Phase 0 intentionally uses Node's built-in runner so the bootstrap stays
 * runnable offline before the workspace has application dependencies.
 */
export default {
  test: {
    environment: "node",
    pool: "forks",
  },
};
