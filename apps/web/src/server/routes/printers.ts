import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { printers, printerStatus } from "@bambu-organize/db";
import { PRINTER_MODELS, lookupPrinterModel } from "@bambu-organize/shared";
import { getDb, newId, now } from "../context.js";
import { createPrinterSchema, updatePrinterSchema } from "../schemas.js";
import { badRequest, parseBody } from "../http.js";

export const printersRouter = new Hono();

/** The machine catalogue, for the "add a printer" dropdown. */
printersRouter.get("/models", (c) => c.json(PRINTER_MODELS));

printersRouter.get("/", async (c) => {
  const db = getDb();
  const [rows, statuses] = await Promise.all([
    db.select().from(printers),
    db.select().from(printerStatus),
  ]);
  const statusById = new Map(statuses.map((s) => [s.printerId, s]));
  return c.json(
    rows
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((printer) => ({ ...printer, status: statusById.get(printer.id) ?? null })),
  );
});

printersRouter.post("/", async (c) => {
  const parsed = await parseBody(c, createPrinterSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const db = getDb();

  // Unknown codes are allowed - a printer released after our catalogue was
  // written still needs to be schedulable - but we default extruder count
  // from the catalogue when we do recognise it.
  const model = lookupPrinterModel(body.modelCode);

  const timestamp = now();
  const printer = {
    id: newId(),
    name: body.name,
    modelCode: body.modelCode,
    serialNumber: body.serialNumber || null,
    nozzleDiameterMm: body.nozzleDiameterMm,
    extruderCount: body.extruderCount ?? model?.extruders ?? 1,
    hasAms: body.hasAms,
    ipAddress: body.ipAddress || null,
    accessCode: null,
    isActive: true,
    sortOrder: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  try {
    await db.insert(printers).values(printer);
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      return badRequest(c, "A printer with that serial number is already registered");
    }
    throw error;
  }

  return c.json(printer, 201);
});

printersRouter.patch("/:id", async (c) => {
  const parsed = await parseBody(c, updatePrinterSchema);
  if (!parsed.ok) return parsed.response;
  const db = getDb();
  const id = c.req.param("id");

  const updated = await db
    .update(printers)
    .set({ ...parsed.data, updatedAt: now() })
    .where(eq(printers.id, id))
    .returning();
  if (updated.length === 0) return c.json({ error: "No such printer" }, 404);
  return c.json(updated[0]);
});

printersRouter.delete("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  // Jobs survive: `jobs.printer_id` is ON DELETE SET NULL, so anything
  // assigned to this machine falls back to "any printer" rather than vanishing.
  const deleted = await db.delete(printers).where(eq(printers.id, id)).returning({ id: printers.id });
  if (deleted.length === 0) return c.json({ error: "No such printer" }, 404);
  return c.json({ ok: true });
});
