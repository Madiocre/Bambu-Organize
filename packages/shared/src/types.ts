/**
 * The domain model, shared by the Hono API and the Astro pages.
 *
 * These mirror the Drizzle tables in @bambu-organize/db but are written by
 * hand so the frontend can import them without pulling drizzle into the
 * client bundle. Timestamps are ISO 8601 strings end to end - SQLite has no
 * date type, and JSON has no date type, so introducing one in the middle
 * only creates conversion points.
 */

/** Where a job sits. The lane a job renders in is derived from this, not stored separately. */
export type JobStatus =
  | "backlog" // added but not committed to a printer's queue - row 1 of the board
  | "queued" // committed and ordered - row 2
  | "printing" // on the machine right now
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["backlog", "queued", "printing", "paused"];

/** How we came by a job's duration. Drives whether the UI shows it as trusted. */
export type EstimateSource =
  | "file" // slicer's `prediction` out of the .3mf - authoritative
  | "manual" // typed in by a human
  | "printer"; // live remaining-time reported by the machine

export type JobEventType =
  | "created"
  | "status_changed"
  | "reordered"
  | "assigned"
  | "file_attached"
  | "edited"
  | "note";

export interface Printer {
  id: string;
  name: string;
  /** `printer_model_id` from the .3mf / MQTT, e.g. "BL-P001" */
  modelCode: string;
  serialNumber?: string | null;
  nozzleDiameterMm: number;
  extruderCount: number;
  hasAms: boolean;
  /** LAN-mode connection details, unused until direct control lands */
  ipAddress?: string | null;
  accessCode?: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface PrintFile {
  id: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  /** `sliced` archives contain plate gcode and could be sent to a printer as-is */
  kind: "project" | "sliced";
  slicerName?: string | null;
  slicerVersion?: string | null;
  plateCount: number;
  createdAt: string;
}

export interface FilePlate {
  id: string;
  fileId: string;
  plateIndex: number;
  name?: string | null;
  /** Slicer estimate in seconds. Null when the .3mf was saved before slicing. */
  predictionSec?: number | null;
  weightG?: number | null;
  printerModelCode?: string | null;
  nozzleDiameters?: string | null;
  supportUsed: boolean;
  labelObjectEnabled: boolean;
  objectCount: number;
  /** Set when the archive carries this plate's gcode */
  gcodePath?: string | null;
  /** A preview was extracted; the bytes live in the plate_thumbnails table */
  hasThumbnail: boolean;
}

export interface PlateFilament {
  id: string;
  plateId: string;
  /** 1-based extruder / AMS slot as recorded in the file */
  filamentIndex: number;
  trayInfoIdx?: string | null;
  type?: string | null;
  colorHex?: string | null;
  usedM?: number | null;
  usedG?: number | null;
}

export interface Job {
  id: string;
  title: string;
  notes?: string | null;
  /** Null means "any printer" - the job sits in the shared backlog */
  printerId?: string | null;
  fileId?: string | null;
  /** Which plate of the file this job prints; a multi-plate file becomes several jobs */
  plateId?: string | null;
  status: JobStatus;
  /** Sort key within the job's lane. Rewritten wholesale on reorder. */
  position: number;
  copies: number;
  /** Print time for a single copy, in minutes */
  estimatedMin: number;
  estimateSource: EstimateSource;
  /** Changeover time after the job: plate swap, cooldown, purge */
  bufferMin: number;
  /** 0 normal, 1 rush. Only affects sorting suggestions, never the committed order. */
  priority: number;
  deadline?: string | null;
  requestedBy?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A job plus the file/plate/printer rows the board needs to render its card. */
export interface JobWithDetails extends Job {
  printer?: Pick<Printer, "id" | "name" | "modelCode"> | null;
  file?: Pick<PrintFile, "id" | "filename" | "kind"> | null;
  plate?: FilePlate | null;
  filaments: PlateFilament[];
}

/** Last-known machine telemetry. Written by the future MQTT bridge; read by the "now printing" card. */
export interface PrinterStatus {
  printerId: string;
  /** Bambu's own gcode_state: IDLE / PREPARE / RUNNING / PAUSE / FINISH / FAILED */
  gcodeState?: string | null;
  currentJobId?: string | null;
  subtaskName?: string | null;
  layerNum?: number | null;
  totalLayerNum?: number | null;
  percentDone?: number | null;
  remainingMin?: number | null;
  nozzleTempC?: number | null;
  bedTempC?: number | null;
  updatedAt: string;
}

export const DEFAULT_BUFFER_MIN = 15;
export const DEFAULT_NOZZLE_MM = 0.4;

/** Total wall-clock a job occupies the machine for, buffer included. */
export function jobTotalMin(job: Pick<Job, "estimatedMin" | "copies" | "bufferMin">): number {
  return job.estimatedMin * Math.max(1, job.copies) + job.bufferMin;
}
