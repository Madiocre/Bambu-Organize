import type { Context } from "hono";
import type { z } from "zod";

export function badRequest(c: Context, message: string) {
  return c.json({ error: message }, 400);
}

type ParseResult<T> = { ok: true; data: T } | { ok: false; response: Response };

/**
 * Validates a JSON body against a zod schema and turns failures into a 400
 * whose `error` is the first human-readable problem - the board surfaces that
 * string directly in its toast, so it has to read like a sentence.
 */
export async function parseBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<ParseResult<z.infer<S>>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: badRequest(c, "Expected a JSON body") };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".");
    const message = issue ? (path ? `${path}: ${issue.message}` : issue.message) : "Invalid body";
    return { ok: false, response: badRequest(c, message) };
  }

  return { ok: true, data: result.data };
}
