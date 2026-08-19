import { Hono } from "hono";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { filePlates, jobEvents, jobs, printFiles } from "@bambu-organize/db";
import {
  DEFAULT_BUFFER_MIN,
  composeJobTitle,
  fileStem,
  type Job,
  type JobStatus,
} from "@bambu-organize/shared";
import { getDb, newId, now } from "../context.js";
import { attachDetails, loadBoard } from "../queries.js";
import { createJobSchema, jobsFromFileSchema, moveJobSchema, updateJobSchema } from "../schemas.js";
import { badRequest, parseBody } from "../http.js";

export const jobsRouter = new Hono();

/** Everything the board renders, in one round trip. */
jobsRouter.get("/board", async (c) => {
  return c.json(await loadBoard());
});

/**
 * A job's history. `job_events` has been written since the first version and
 * read by nothing; this is what makes those rows worth their storage.
 */
jobsRouter.get("/:id/events", async (c) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, c.req.param("id")))
    .orderBy(desc(jobEvents.createdAt));
  return c.json(rows);
});

jobsRouter.get("/", async (c) => {
  const db = getDb();
  const rows = (await db.select().from(jobs)) as unknown as Job[];
  return c.json(await attachDetails(rows));
});

jobsRouter.post("/", async (c) => {
  const parsed = await parseBody(c, createJobSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const db = getDb();

  // A plate's `prediction` beats anything the client sends. Reading it here
  // rather than trusting the request body is what keeps "duration came from
  // the file" an honest claim on the card.
  let estimatedMin = body.estimatedMin ?? 0;
  let estimateSource: Job["estimateSource"] = "manual";
  let title = body.title ?? "Untitled job";
  let fileId: string | null = null;

  if (body.plateId) {
    const [plate] = await db.select().from(filePlates).where(eq(filePlates.id, body.plateId));
    if (!plate) return badRequest(c, "plateId does not match any known plate");
    fileId = plate.fileId;
    if (plate.predictionSec != null) {
      estimatedMin = Math.max(1, Math.round(plate.predictionSec / 60));
      estimateSource = "file";
    } else if (!body.estimatedMin) {
      return badRequest(
        c,
        "That plate has no print-time estimate in the file - send estimatedMin as well",
      );
    }
    if (!body.title) {
      // Plates are all called "Plate 1" inside a .3mf, so a title built from
      // that alone makes every customer's job look identical on the board.
      const [file] = await db.select().from(printFiles).where(eq(printFiles.id, plate.fileId));
      title = composeJobTitle({
        requestedBy: body.requestedBy,
        product: plate.name || (file ? fileStem(file.filename) : null),
        plateIndex: plate.plateIndex,
      });
    }
  }

  const timestamp = now();
  const job = {
    id: newId(),
    title,
    notes: body.notes ?? null,
    printerId: body.printerId ?? null,
    fileId,
    plateId: body.plateId ?? null,
    status: body.status,
    position: await nextPosition(body.status),
    copies: body.copies,
    estimatedMin,
    estimateSource,
    bufferMin: body.bufferMin ?? DEFAULT_BUFFER_MIN,
    priority: body.priority,
    deadline: body.deadline ?? null,
    requestedBy: body.requestedBy ?? null,
    startedAt: null,
    finishedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await db.insert(jobs).values(job);
  await recordEvent(job.id, "created", `Added to ${job.status}`);

  const [detailed] = await attachDetails([job as unknown as Job]);
  return c.json(detailed, 201);
});

/** Bulk-create one job per plate of an uploaded file - the usual path after an upload. */
jobsRouter.post("/from-file", async (c) => {
  const parsed = await parseBody(c, jobsFromFileSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const db = getDb();

  const plates = await db.select().from(filePlates).where(eq(filePlates.fileId, body.fileId));
  if (plates.length === 0) {
    // Unreachable for uploads since files.ts rejects unsliced archives, but
    // kept honest: this means the file record has no plates, not that the
    // archive had none.
    return badRequest(c, "That file has no plates recorded - try uploading it again");
  }

  const [file] = await db.select().from(printFiles).where(eq(printFiles.id, body.fileId));
  const product = file ? fileStem(file.filename) : null;

  const wanted =
    body.plateIndexes.length > 0
      ? plates.filter((plate) => body.plateIndexes.includes(plate.plateIndex))
      : plates;
  if (wanted.length === 0) return badRequest(c, "None of the requested plate indexes exist");

  const withoutEstimate = wanted.filter((plate) => plate.predictionSec == null);
  if (withoutEstimate.length === wanted.length) {
    return badRequest(
      c,
      "None of those plates carry a print-time estimate - add the jobs manually with a duration",
    );
  }

  const timestamp = now();
  let position = await nextPosition(body.status);

  const rows = wanted
    .filter((plate) => plate.predictionSec != null)
    .sort((a, b) => a.plateIndex - b.plateIndex)
    .map((plate) => ({
      id: newId(),
      title: composeJobTitle({
        requestedBy: body.requestedBy,
        product: plate.name || product,
        plateIndex: plate.plateIndex,
      }),
      notes: body.notes ?? null,
      printerId: body.printerId ?? null,
      fileId: plate.fileId,
      plateId: plate.id,
      status: body.status,
      position: (position += 1),
      copies: body.copies,
      estimatedMin: Math.max(1, Math.round((plate.predictionSec as number) / 60)),
      estimateSource: "file" as const,
      bufferMin: body.bufferMin,
      priority: body.priority,
      deadline: body.deadline ?? null,
      requestedBy: body.requestedBy ?? null,
      startedAt: null,
      finishedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));

  await db.insert(jobs).values(rows);
  await Promise.all(rows.map((row) => recordEvent(row.id, "created", "Created from uploaded file")));

  return c.json(
    {
      jobs: await attachDetails(rows as unknown as Job[]),
      skipped: withoutEstimate.map((plate) => plate.plateIndex),
    },
    201,
  );
});

jobsRouter.patch("/:id", async (c) => {
  const parsed = await parseBody(c, updateJobSchema);
  if (!parsed.ok) return parsed.response;
  const db = getDb();
  const id = c.req.param("id");

  const [existing] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!existing) return c.json({ error: "No such job" }, 404);

  const patch: Record<string, unknown> = { ...parsed.data, updatedAt: now() };
  // Editing the duration by hand means it is no longer the slicer's number.
  if (parsed.data.estimatedMin !== undefined && parsed.data.estimateSource === undefined) {
    patch.estimateSource = "manual";
  }
  if (parsed.data.status) {
    Object.assign(patch, statusTransitionFields(parsed.data.status, existing as unknown as Job));
  }

  await db.update(jobs).set(patch).where(eq(jobs.id, id));
  if (parsed.data.status && parsed.data.status !== existing.status) {
    await recordEvent(id, "status_changed", `${existing.status} → ${parsed.data.status}`);
  } else {
    await recordEvent(id, "edited", null);
  }

  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  const [detailed] = await attachDetails([row as unknown as Job]);
  return c.json(detailed);
});

/**
 * Every drag on the board lands here. `order` is the destination lane's full
 * id list after the drop, so positions are rewritten rather than nudged - no
 * fractional drift, and the persisted order always matches the screen.
 */
jobsRouter.post("/move", async (c) => {
  const parsed = await parseBody(c, moveJobSchema);
  if (!parsed.ok) return parsed.response;
  const { jobId, status, printerId, order } = parsed.data;
  const db = getDb();

  const [existing] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!existing) return c.json({ error: "No such job" }, 404);

  const targetPrinterId = printerId === undefined ? existing.printerId : printerId;

  // One print at a time per machine. Rejecting is better than silently
  // demoting whatever was already running.
  if (status === "printing") {
    const conflicts = await db
      .select({ id: jobs.id, title: jobs.title })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "printing"),
          ne(jobs.id, jobId),
          targetPrinterId ? eq(jobs.printerId, targetPrinterId) : sql`1 = 1`,
        ),
      );
    if (conflicts.length > 0) {
      return c.json(
        {
          error: `"${conflicts[0]!.title}" is already printing on that machine. Finish or pause it first.`,
        },
        409,
      );
    }
  }

  const timestamp = now();
  await db
    .update(jobs)
    .set({
      status,
      printerId: targetPrinterId,
      updatedAt: timestamp,
      ...statusTransitionFields(status, existing as unknown as Job),
    })
    .where(eq(jobs.id, jobId));

  // Positions only mean anything inside a lane, so rewrite the destination
  // lane wholesale. Ids the client sent that are no longer in that lane are
  // ignored by the `inArray` guard rather than resurrecting stale rows.
  const ordered = order.includes(jobId) ? order : [...order, jobId];
  if (ordered.length > 0) {
    const laneRows = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.status, status), inArray(jobs.id, ordered)));
    const laneIds = new Set(laneRows.map((row) => row.id));

    const updates = ordered
      .filter((id) => laneIds.has(id))
      .map((id, index) =>
        db.update(jobs).set({ position: index, updatedAt: timestamp }).where(eq(jobs.id, id)),
      );
    // `batch` wants a non-empty tuple type, which a filtered array cannot
    // prove; the length check above is the runtime guarantee.
    if (updates.length > 0) {
      await db.batch(updates as unknown as Parameters<typeof db.batch>[0]);
    }
  }

  await recordEvent(
    jobId,
    existing.status === status ? "reordered" : "status_changed",
    existing.status === status ? `Reordered within ${status}` : `${existing.status} → ${status}`,
  );

  return c.json(await loadBoard());
});

jobsRouter.delete("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const deleted = await db.delete(jobs).where(eq(jobs.id, id)).returning({ id: jobs.id });
  if (deleted.length === 0) return c.json({ error: "No such job" }, 404);
  return c.json({ ok: true });
});

/** Timestamps that should follow a status change, rather than being client-supplied. */
function statusTransitionFields(status: JobStatus, existing?: Job): Record<string, unknown> {
  switch (status) {
    case "printing":
      return { startedAt: existing?.startedAt ?? now(), finishedAt: null };
    case "done":
    case "failed":
    case "cancelled":
      return { finishedAt: now() };
    case "backlog":
    case "queued":
      // Re-queuing an abandoned print clears the run so its timeline is honest.
      return { startedAt: null, finishedAt: null };
    default:
      return {};
  }
}

async function nextPosition(status: JobStatus): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ max: sql<number | null>`max(${jobs.position})` })
    .from(jobs)
    .where(eq(jobs.status, status));
  return (row?.max ?? -1) + 1;
}

async function recordEvent(jobId: string, type: string, message: string | null): Promise<void> {
  const db = getDb();
  await db.insert(jobEvents).values({
    id: newId(),
    jobId,
    type,
    message,
    payload: null,
    createdAt: now(),
  });
}
