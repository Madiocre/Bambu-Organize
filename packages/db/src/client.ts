import { drizzle, type AnyD1Database } from "drizzle-orm/d1";

/**
 * Native Workers binding path - `d1` is the D1Database Cloudflare injects at
 * the edge. This only works inside a Worker; there is no clean standalone-Node
 * equivalent for the runtime query path. drizzle-kit's separate d1-http driver
 * (drizzle.config.ts) is the supported way to run migrations/push/studio from
 * outside a Worker, and is unaffected by this file.
 *
 * The parameter is typed with drizzle's own `AnyD1Database` rather than the
 * global `D1Database`. This package is consumed by the Worker, where that
 * global comes from `wrangler types` output that only exists in apps/web -
 * taking it from the driver keeps this package self-contained and means no
 * hand-maintained binding types anywhere.
 *
 * No `relations` are declared: drizzle 1.x replaced the old `schema` option
 * with a relations graph that only powers `db.query.*`. Every read here is an
 * explicit select (see apps/web/src/server/queries.ts), so the graph would be
 * a second description of the schema with nothing consuming it.
 */
export function createDb(d1: AnyD1Database) {
  return drizzle(d1);
}

export type Db = ReturnType<typeof createDb>;
