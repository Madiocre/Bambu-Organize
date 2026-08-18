import { z } from "zod";

/** Statuses a human can move a job into from the board. */
export const jobStatusSchema = z.enum([
  "backlog",
  "queued",
  "printing",
  "paused",
  "done",
  "failed",
  "cancelled",
]);

export const estimateSourceSchema = z.enum(["file", "manual", "printer"]);

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Expected an ISO 8601 date" });

export const createJobSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().max(2000).nullish(),
    printerId: z.string().nullish(),
    /**
     * Attaching a plate is how a job gets a trustworthy duration: the server
     * reads `prediction` off the plate rather than believing the client, so
     * `estimatedMin` is only consulted when there is no plate.
     */
    plateId: z.string().nullish(),
    estimatedMin: z.number().int().min(1).max(60 * 24 * 30).optional(),
    copies: z.number().int().min(1).max(999).default(1),
    bufferMin: z.number().int().min(0).max(600).default(15),
    priority: z.number().int().min(0).max(1).default(0),
    deadline: isoDate.nullish(),
    requestedBy: z.string().trim().max(120).nullish(),
    status: z.enum(["backlog", "queued"]).default("backlog"),
  })
  .refine((value) => Boolean(value.plateId) || value.estimatedMin !== undefined, {
    message: "Provide either a plateId (duration comes from the file) or estimatedMin",
    path: ["estimatedMin"],
  })
  .refine((value) => Boolean(value.plateId) || Boolean(value.title), {
    message: "title is required when the job is not created from a file",
    path: ["title"],
  });

export const updateJobSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(2000).nullish(),
  printerId: z.string().nullish(),
  estimatedMin: z.number().int().min(1).max(60 * 24 * 30).optional(),
  estimateSource: estimateSourceSchema.optional(),
  copies: z.number().int().min(1).max(999).optional(),
  bufferMin: z.number().int().min(0).max(600).optional(),
  priority: z.number().int().min(0).max(1).optional(),
  deadline: isoDate.nullish(),
  requestedBy: z.string().trim().max(120).nullish(),
  status: jobStatusSchema.optional(),
});

/**
 * One endpoint covers every drag on the board. The client sends the
 * destination lane and that lane's full id list *after* the drop, so the
 * server never has to reconstruct intent from a position delta - it writes
 * exactly what the user sees.
 */
export const moveJobSchema = z.object({
  jobId: z.string().min(1),
  status: jobStatusSchema,
  printerId: z.string().nullish(),
  order: z.array(z.string().min(1)).max(500).default([]),
});

export const createPrinterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  modelCode: z.string().trim().min(1).max(40),
  serialNumber: z.string().trim().max(60).nullish(),
  nozzleDiameterMm: z.number().min(0.1).max(2).default(0.4),
  extruderCount: z.number().int().min(1).max(4).default(1),
  hasAms: z.boolean().default(false),
  ipAddress: z.string().trim().max(60).nullish(),
});

export const updatePrinterSchema = createPrinterSchema.partial().extend({
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

/**
 * Turn plates from an uploaded file into queue entries.
 *
 * A .3mf describes the *print*, never the job around it - there is no client
 * name, due date or instruction anywhere in the format. Those three come from
 * the person doing the intake and are applied to every plate in the batch,
 * which is nearly always what is wanted: one customer, one drop-off, one due
 * date, several plates.
 */
export const jobsFromFileSchema = z.object({
  fileId: z.string().min(1),
  /** Plate indexes to create jobs for; empty means every plate in the file. */
  plateIndexes: z.array(z.number().int().min(1)).default([]),
  printerId: z.string().nullish(),
  status: z.enum(["backlog", "queued"]).default("backlog"),
  copies: z.number().int().min(1).max(999).default(1),
  bufferMin: z.number().int().min(0).max(600).default(15),
  deadline: isoDate.nullish(),
  requestedBy: z.string().trim().max(120).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  priority: z.number().int().min(0).max(1).default(0),
});
