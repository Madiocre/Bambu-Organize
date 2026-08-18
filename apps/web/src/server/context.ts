import { env } from "cloudflare:workers";
import { createDb, type Db } from "@bambu-organize/db";

/**
 * Bindings come from `cloudflare:workers` rather than a Hono `c.env`.
 *
 * Astro invokes `src/fetch.ts` with a bare `Request` (see FetchHandler in
 * astro/dist/core/fetch/types.d.ts), so Hono never receives Cloudflare's
 * `env`/`ctx` arguments and `c.env` is empty. The global env proxy is the
 * adapter's own supported path in Astro 7 - `Astro.locals.runtime.env` was
 * removed and throws with a message pointing here.
 */
export function getDb(): Db {
  return createDb(env.DB);
}

export function now(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}
