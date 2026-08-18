import { inArray } from "drizzle-orm";
import { filePlates, jobs, plateFilaments, printers, printFiles, printerStatus } from "@bambu-organize/db";
import type {
  FilePlate,
  Job,
  JobWithDetails,
  PlateFilament,
  PrintFile,
  Printer,
  PrinterStatus,
} from "@bambu-organize/shared";
import { getDb } from "./context.js";

/** Statuses the board actually renders. Everything else lives on /records. */
const BOARD_STATUSES = ["backlog", "queued", "printing"] as const;

/**
 * The board needs every active job plus the file/plate/filament rows behind
 * it. That is a four-way join fanning out to many filament rows, which SQL
 * would return as a cartesian product we'd have to de-duplicate anyway - so
 * we issue a handful of `IN` queries and stitch in JS instead. Queues here
 * are tens of rows; the round trips are all to the same D1 instance.
 */
export async function loadBoard(): Promise<{
  jobs: JobWithDetails[];
  printers: Printer[];
  statuses: PrinterStatus[];
}> {
  const db = getDb();

  const [jobRows, printerRows, statusRows] = await Promise.all([
    // Closed and paused jobs are never drawn on the board, and reading them
    // here made every render cost the whole history - a query that gets
    // slower forever. /records asks for them explicitly instead.
    db.select().from(jobs).where(inArray(jobs.status, [...BOARD_STATUSES])),
    db.select().from(printers),
    db.select().from(printerStatus),
  ]);

  const detailed = await attachDetails(jobRows as unknown as Job[]);

  return {
    jobs: detailed,
    printers: (printerRows as unknown as Printer[]).sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    ),
    statuses: statusRows as unknown as PrinterStatus[],
  };
}

/** Everything, including closed and paused work. Only book-keeping wants this. */
export async function loadAllJobs(): Promise<JobWithDetails[]> {
  const db = getDb();
  const rows = await db.select().from(jobs);
  return attachDetails(rows as unknown as Job[]);
}

export async function attachDetails(jobRows: Job[]): Promise<JobWithDetails[]> {
  if (jobRows.length === 0) return [];
  const db = getDb();

  const fileIds = unique(jobRows.map((job) => job.fileId));
  const plateIds = unique(jobRows.map((job) => job.plateId));
  const printerIds = unique(jobRows.map((job) => job.printerId));

  const [fileRows, plateRows, printerRows] = await Promise.all([
    fileIds.length ? db.select().from(printFiles).where(inArray(printFiles.id, fileIds)) : [],
    plateIds.length ? db.select().from(filePlates).where(inArray(filePlates.id, plateIds)) : [],
    printerIds.length ? db.select().from(printers).where(inArray(printers.id, printerIds)) : [],
  ]);

  const filamentRows = plateIds.length
    ? await db.select().from(plateFilaments).where(inArray(plateFilaments.plateId, plateIds))
    : [];

  const fileById = index(fileRows as unknown as PrintFile[]);
  const plateById = index(plateRows as unknown as FilePlate[]);
  const printerById = index(printerRows as unknown as Printer[]);

  const filamentsByPlate = new Map<string, PlateFilament[]>();
  for (const filament of filamentRows as unknown as PlateFilament[]) {
    const list = filamentsByPlate.get(filament.plateId) ?? [];
    list.push(filament);
    filamentsByPlate.set(filament.plateId, list);
  }
  for (const list of filamentsByPlate.values()) {
    list.sort((a, b) => a.filamentIndex - b.filamentIndex);
  }

  return jobRows.map((job) => {
    const printer = job.printerId ? printerById.get(job.printerId) : undefined;
    const file = job.fileId ? fileById.get(job.fileId) : undefined;
    const plate = job.plateId ? plateById.get(job.plateId) : undefined;
    return {
      ...job,
      printer: printer
        ? { id: printer.id, name: printer.name, modelCode: printer.modelCode }
        : null,
      file: file ? { id: file.id, filename: file.filename, kind: file.kind } : null,
      plate: plate ?? null,
      filaments: plate ? (filamentsByPlate.get(plate.id) ?? []) : [],
    };
  });
}

function unique(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

function index<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}
