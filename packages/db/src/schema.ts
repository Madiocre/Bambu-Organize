import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Schema notes
 *
 * - Timestamps are ISO 8601 text. SQLite has no date type and the API speaks
 *   JSON, so storing anything else just adds two conversion points.
 * - A job's lane on the board is derived from `status`, not stored. `position`
 *   orders a job within its lane and is rewritten wholesale on every drop
 *   (see the reorder route) - queues here are tens of rows, so a batched
 *   rewrite is simpler and drift-free compared to fractional indexing.
 * - File metadata is split three ways because a .3mf legitimately holds many
 *   plates and each plate many filaments. One job prints one plate, so a
 *   four-plate project naturally becomes four jobs sharing one upload.
 * - `printer_status` is written by nothing yet. It exists so the "now
 *   printing" card has a home the day the MQTT bridge lands, without a
 *   migration that touches jobs.
 */

export const printers = sqliteTable(
  "printers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** `printer_model_id` from slice_info.config / MQTT, e.g. "BL-P001" */
    modelCode: text("model_code").notNull(),
    serialNumber: text("serial_number"),
    nozzleDiameterMm: real("nozzle_diameter_mm").notNull().default(0.4),
    extruderCount: integer("extruder_count").notNull().default(1),
    hasAms: integer("has_ams", { mode: "boolean" }).notNull().default(false),
    /** LAN-mode details for the future direct-control phase */
    ipAddress: text("ip_address"),
    accessCode: text("access_code"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("printers_serial_idx").on(table.serialNumber)],
);

export const printFiles = sqliteTable("print_files", {
  id: text("id").primaryKey(),
  filename: text("filename").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  /** 'sliced' archives carry plate gcode and could be sent to a printer as-is */
  kind: text("kind").notNull().default("project"),
  slicerName: text("slicer_name"),
  slicerVersion: text("slicer_version"),
  plateCount: integer("plate_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const filePlates = sqliteTable(
  "file_plates",
  {
    id: text("id").primaryKey(),
    fileId: text("file_id")
      .notNull()
      .references(() => printFiles.id, { onDelete: "cascade" }),
    plateIndex: integer("plate_index").notNull(),
    name: text("name"),
    /** Slicer's `prediction`, in seconds - the queue's primary duration input */
    predictionSec: integer("prediction_sec"),
    weightG: real("weight_g"),
    printerModelCode: text("printer_model_code"),
    /** One diameter per extruder, comma separated on multi-extruder machines */
    nozzleDiameters: text("nozzle_diameters"),
    supportUsed: integer("support_used", { mode: "boolean" }).notNull().default(false),
    labelObjectEnabled: integer("label_object_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    objectCount: integer("object_count").notNull().default(0),
    /** Zip entry name for this plate's gcode, when the archive has one */
    gcodePath: text("gcode_path"),
    /** Whether a preview was extracted; the bytes live in `plate_thumbnails` */
    hasThumbnail: integer("has_thumbnail", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [uniqueIndex("file_plates_file_index_idx").on(table.fileId, table.plateIndex)],
);

export const plateFilaments = sqliteTable(
  "plate_filaments",
  {
    id: text("id").primaryKey(),
    plateId: text("plate_id")
      .notNull()
      .references(() => filePlates.id, { onDelete: "cascade" }),
    /** 1-based extruder / AMS slot as recorded in the file */
    filamentIndex: integer("filament_index").notNull(),
    /** Bambu filament catalogue id, e.g. "GFA00" */
    trayInfoIdx: text("tray_info_idx"),
    type: text("type"),
    colorHex: text("color_hex"),
    usedM: real("used_m"),
    usedG: real("used_g"),
  },
  (table) => [index("plate_filaments_plate_idx").on(table.plateId)],
);

/**
 * Plate previews, held in their own table on purpose.
 *
 * R2 would be the natural home, but it requires a card on the Cloudflare
 * account, and this deployment does not have one. Real Bambu previews are
 * 18-22 KB, so D1 holds them comfortably - its ceiling is 2 MB per row.
 *
 * They are a separate table rather than a column on `file_plates` because the
 * board reads plates on every render; a blob column would drag tens of KB per
 * plate into a query that only wants durations. Nothing joins to this table
 * except the one route that serves an image.
 *
 * Stored base64 because drizzle's `blob({ mode: "buffer" })` maps to a Node
 * `Buffer`, which does not exist in workerd. The ~33% overhead is irrelevant
 * at this size.
 */
export const plateThumbnails = sqliteTable("plate_thumbnails", {
  plateId: text("plate_id")
    .primaryKey()
    .references(() => filePlates.id, { onDelete: "cascade" }),
  contentType: text("content_type").notNull().default("image/png"),
  dataBase64: text("data_base64").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    notes: text("notes"),
    /** Null = unassigned, sitting in the shared backlog */
    printerId: text("printer_id").references(() => printers.id, { onDelete: "set null" }),
    fileId: text("file_id").references(() => printFiles.id, { onDelete: "set null" }),
    plateId: text("plate_id").references(() => filePlates.id, { onDelete: "set null" }),
    /** backlog | queued | printing | paused | done | failed | cancelled */
    status: text("status").notNull().default("backlog"),
    position: real("position").notNull().default(0),
    copies: integer("copies").notNull().default(1),
    /** Minutes for a single copy */
    estimatedMin: integer("estimated_min").notNull(),
    /** file | manual | printer */
    estimateSource: text("estimate_source").notNull().default("manual"),
    bufferMin: integer("buffer_min").notNull().default(15),
    priority: integer("priority").notNull().default(0),
    deadline: text("deadline"),
    requestedBy: text("requested_by"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("jobs_status_position_idx").on(table.status, table.position),
    index("jobs_printer_idx").on(table.printerId),
  ],
);

export const jobEvents = sqliteTable(
  "job_events",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    message: text("message"),
    /** JSON blob - whatever context the event needs, unqueried */
    payload: text("payload"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("job_events_job_idx").on(table.jobId, table.createdAt)],
);

/**
 * Single-row configuration, keyed on the literal id "default".
 *
 * Only costing lives here so far. A key/value table would be more flexible and
 * far less typed; with three fields, columns are worth more than flexibility.
 */
export const appSettings = sqliteTable("app_settings", {
  id: text("id").primaryKey(),
  /** Free text so any currency works - this is not a money-handling app */
  currency: text("currency").notNull().default(""),
  machineRatePerHour: real("machine_rate_per_hour").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Price per kilogram, per filament type.
 *
 * A single rate only worked for a workshop that runs one material. PLA, PETG
 * and ABS are not interchangeable in price, and the type is already recorded
 * per filament by the slicer - so the cost model uses it rather than a plate's
 * total weight. Rows are only created for types that have actually been
 * printed, so the settings form never lists materials nobody owns.
 */
export const filamentPrices = sqliteTable("filament_prices", {
  /** Uppercased slicer type, e.g. "PLA", "PETG", "PLA-S" */
  type: text("type").primaryKey(),
  costPerKg: real("cost_per_kg").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

/** One row per printer, upserted by the (not yet written) MQTT bridge. */
export const printerStatus = sqliteTable("printer_status", {
  printerId: text("printer_id")
    .primaryKey()
    .references(() => printers.id, { onDelete: "cascade" }),
  /** Bambu's gcode_state: IDLE / PREPARE / RUNNING / PAUSE / FINISH / FAILED */
  gcodeState: text("gcode_state"),
  currentJobId: text("current_job_id").references(() => jobs.id, { onDelete: "set null" }),
  subtaskName: text("subtask_name"),
  layerNum: integer("layer_num"),
  totalLayerNum: integer("total_layer_num"),
  percentDone: integer("percent_done"),
  remainingMin: integer("remaining_min"),
  nozzleTempC: real("nozzle_temp_c"),
  bedTempC: real("bed_temp_c"),
  /** Raw AMS tray JSON, kept whole until we know what we want out of it */
  amsJson: text("ams_json"),
  updatedAt: text("updated_at").notNull(),
});
