// Replaced at build time by esbuild `define` (scripts/build.mjs). Undefined in tests.
declare const LAIDIR_VERSION: string | undefined;

/** Git commit SHA of the deployed code, or "dev" when running unbundled (tests, local). */
export const VERSION: string = typeof LAIDIR_VERSION === "string" ? LAIDIR_VERSION : "dev";

/** Highest entity schema version this deployment accepts (see schemas/). */
export const SCHEMA_VERSION = 1;

/** Added to every response so a deploy can be verified end to end. */
export const VERSION_HEADER = { "x-laidir-version": VERSION } as const;
