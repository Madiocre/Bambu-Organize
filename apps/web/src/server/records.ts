import { eq } from "drizzle-orm";
import { appSettings, filamentPrices } from "@bambu-organize/db";
import {
  createXlsx,
  filamentKey,
  isClosed,
  jobCost,
  type CostSettings,
  type JobWithDetails,
  type Sheet,
} from "@bambu-organize/shared";
import { getDb, now } from "./context.js";

const SETTINGS_ID = "default";

/** Costing is off until someone fills the rates in; zero rates give zero costs. */
const DEFAULT_SETTINGS: CostSettings = {
  currency: "",
  machineRatePerHour: 0,
  filamentPrices: {},
};

export async function loadSettings(): Promise<CostSettings> {
  const db = getDb();
  const [[row], priceRows] = await Promise.all([
    db.select().from(appSettings).where(eq(appSettings.id, SETTINGS_ID)),
    db.select().from(filamentPrices),
  ]);

  return {
    currency: row?.currency ?? DEFAULT_SETTINGS.currency,
    machineRatePerHour: row?.machineRatePerHour ?? DEFAULT_SETTINGS.machineRatePerHour,
    filamentPrices: Object.fromEntries(priceRows.map((p) => [p.type, p.costPerKg])),
  };
}

export async function saveSettings(next: CostSettings): Promise<CostSettings> {
  const db = getDb();
  const stamp = now();
  const base = { currency: next.currency, machineRatePerHour: next.machineRatePerHour };

  // Upsert: the row may never have been created, and there is only ever one.
  await db
    .insert(appSettings)
    .values({ id: SETTINGS_ID, ...base, updatedAt: stamp })
    .onConflictDoUpdate({ target: appSettings.id, set: { ...base, updatedAt: stamp } });

  // One row per filament type. Written individually because there are a
  // handful at most, and a batch would need a non-empty tuple type for no gain.
  for (const [type, costPerKg] of Object.entries(next.filamentPrices)) {
    const key = filamentKey(type);
    if (!key) continue;
    await db
      .insert(filamentPrices)
      .values({ type: key, costPerKg, updatedAt: stamp })
      .onConflictDoUpdate({ target: filamentPrices.type, set: { costPerKg, updatedAt: stamp } });
  }

  return loadSettings();
}

export interface ClientRecord {
  /** Empty string is the "no client recorded" bucket */
  client: string;
  jobs: number;
  completed: number;
  failed: number;
  openJobs: number;
  machineMinutes: number;
  filamentGrams: number;
  cost: number;
  /** True when at least one job had no plate, so filament and cost understate */
  partial: boolean;
  firstJobAt: string | null;
  lastJobAt: string | null;
}

export interface RecordsPayload {
  settings: CostSettings;
  /** Filament types seen in any job, so the rates form lists only real materials */
  filamentTypes: string[];
  clients: ClientRecord[];
  /** Finished work, newest first */
  history: JobRecord[];
  /** Still-open jobs that are not on the board's lanes - i.e. paused */
  paused: JobRecord[];
  totals: {
    jobs: number;
    completed: number;
    failed: number;
    machineMinutes: number;
    filamentGrams: number;
    cost: number;
    clients: number;
  };
}

export interface JobRecord {
  id: string;
  title: string;
  client: string;
  status: string;
  printer: string | null;
  copies: number;
  machineMinutes: number;
  filamentGrams: number;
  filamentKnown: boolean;
  /** Types printed with no price set; the cost understates by these */
  unpricedTypes: string[];
  cost: number;
  deadline: string | null;
  /** Whether the job actually landed before its deadline - only meaningful once closed */
  metDeadline: boolean | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  notes: string | null;
}

function toRecord(job: JobWithDetails, settings: CostSettings): JobRecord {
  // `job.filaments` is the per-type breakdown from the slicer, which is what
  // per-type pricing needs; the plate's total weight cannot be costed.
  const cost = jobCost(job, settings);
  return {
    id: job.id,
    title: job.title,
    client: job.requestedBy?.trim() ?? "",
    status: job.status,
    printer: job.printer?.name ?? null,
    copies: job.copies,
    machineMinutes: cost.machineMinutes,
    filamentGrams: cost.filamentGrams,
    filamentKnown: cost.filamentKnown,
    unpricedTypes: cost.unpricedTypes,
    cost: cost.total,
    deadline: job.deadline ?? null,
    metDeadline:
      job.deadline && job.finishedAt
        ? new Date(job.finishedAt).getTime() <= new Date(job.deadline).getTime()
        : null,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    createdAt: job.createdAt,
    notes: job.notes ?? null,
  };
}

/**
 * The book-keeping view.
 *
 * Clients are grouped by `requestedBy` rather than by a client table - there
 * isn't one yet, and inventing one here would fork the source of truth. When
 * clients become real records this aggregation is what they replace.
 */
export function buildRecords(
  jobs: JobWithDetails[],
  settings: CostSettings,
): RecordsPayload {
  const records = jobs.map((job) => toRecord(job, settings));

  const history = records
    .filter((record) => isClosed(record.status as never))
    .sort((a, b) =>
      (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt),
    );

  const paused = records
    .filter((record) => record.status === "paused")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const byClient = new Map<string, ClientRecord>();
  for (const record of records) {
    const key = record.client;
    const entry = byClient.get(key) ?? {
      client: key,
      jobs: 0,
      completed: 0,
      failed: 0,
      openJobs: 0,
      machineMinutes: 0,
      filamentGrams: 0,
      cost: 0,
      partial: false,
      firstJobAt: null,
      lastJobAt: null,
    };

    entry.jobs += 1;
    if (record.status === "done") entry.completed += 1;
    if (record.status === "failed") entry.failed += 1;
    if (!isClosed(record.status as never)) entry.openJobs += 1;

    // Only finished work counts toward spend; a queued job has not cost
    // anything yet, and counting it would make the totals a forecast.
    if (record.status === "done") {
      entry.machineMinutes += record.machineMinutes;
      entry.filamentGrams += record.filamentGrams;
      entry.cost += record.cost;
      if (!record.filamentKnown || record.unpricedTypes.length > 0) entry.partial = true;
    }

    const stamp = record.finishedAt ?? record.createdAt;
    if (!entry.firstJobAt || stamp < entry.firstJobAt) entry.firstJobAt = stamp;
    if (!entry.lastJobAt || stamp > entry.lastJobAt) entry.lastJobAt = stamp;

    byClient.set(key, entry);
  }

  const clients = [...byClient.values()].sort(
    (a, b) =>
      b.cost - a.cost || b.jobs - a.jobs || a.client.localeCompare(b.client),
  );

  const done = records.filter((record) => record.status === "done");
  const filamentTypes = [
    ...new Set(
      jobs.flatMap((job) => job.filaments.map((f) => filamentKey(f.type))).filter(Boolean),
    ),
  ].sort();

  return {
    settings,
    filamentTypes,
    clients,
    history,
    paused,
    totals: {
      jobs: records.length,
      completed: done.length,
      failed: records.filter((r) => r.status === "failed").length,
      machineMinutes: done.reduce((sum, r) => sum + r.machineMinutes, 0),
      filamentGrams: done.reduce((sum, r) => sum + r.filamentGrams, 0),
      cost: done.reduce((sum, r) => sum + r.cost, 0),
      clients: clients.filter((c) => c.client).length,
    },
  };
}

/** Previous calendar month, in local time - the period an accountant asks for. */
export function lastMonthRange(now: Date = new Date()): {
  from: Date;
  to: Date;
  label: string;
} {
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const label = from.toLocaleDateString([], { month: "long", year: "numeric" });
  return { from, to, label };
}

/** Narrows a payload to jobs finished inside a window, re-deriving the rollups. */
export function scopeToPeriod(
  payload: RecordsPayload,
  from: Date,
  to: Date,
): RecordsPayload {
  const inRange = (job: JobRecord) => {
    const stamp = new Date(job.finishedAt ?? job.createdAt).getTime();
    return stamp >= from.getTime() && stamp < to.getTime();
  };

  const history = payload.history.filter(inRange);
  const done = history.filter((job) => job.status === "done");

  const byClient = new Map<string, ClientRecord>();
  for (const job of history) {
    const entry = byClient.get(job.client) ?? {
      client: job.client,
      jobs: 0,
      completed: 0,
      failed: 0,
      openJobs: 0,
      machineMinutes: 0,
      filamentGrams: 0,
      cost: 0,
      partial: false,
      firstJobAt: null,
      lastJobAt: null,
    };
    entry.jobs += 1;
    if (job.status === "done") {
      entry.completed += 1;
      entry.machineMinutes += job.machineMinutes;
      entry.filamentGrams += job.filamentGrams;
      entry.cost += job.cost;
      if (!job.filamentKnown || job.unpricedTypes.length > 0) entry.partial = true;
    }
    if (job.status === "failed") entry.failed += 1;
    const stamp = job.finishedAt ?? job.createdAt;
    if (!entry.firstJobAt || stamp < entry.firstJobAt) entry.firstJobAt = stamp;
    if (!entry.lastJobAt || stamp > entry.lastJobAt) entry.lastJobAt = stamp;
    byClient.set(job.client, entry);
  }

  return {
    ...payload,
    history,
    paused: [],
    clients: [...byClient.values()].sort((a, b) => b.cost - a.cost),
    totals: {
      jobs: history.length,
      completed: done.length,
      failed: history.filter((job) => job.status === "failed").length,
      machineMinutes: done.reduce((sum, job) => sum + job.machineMinutes, 0),
      filamentGrams: done.reduce((sum, job) => sum + job.filamentGrams, 0),
      cost: done.reduce((sum, job) => sum + job.cost, 0),
      clients: new Set(done.map((job) => job.client).filter(Boolean)).size,
    },
  };
}

/** Both sheets in one file, which is what "a report" means to whoever asks for one. */
export function buildMonthlyReport(
  payload: RecordsPayload,
  label: string,
  when: Date = new Date(),
): { bytes: Uint8Array<ArrayBuffer>; filename: string } {
  const summary = clientsSheet(payload);
  const detail = historySheet(payload);
  summary.name = `Clients — ${label}`.slice(0, 31);
  detail.name = `Jobs — ${label}`.slice(0, 31);

  const slug = label.toLowerCase().replace(/\s+/g, "-");
  return {
    bytes: createXlsx([summary, detail], when),
    filename: `printflow-report-${slug}.xlsx`,
  };
}

export function buildRecordsWorkbook(
  payload: RecordsPayload,
  view: "clients" | "history",
  when: Date = new Date(),
): { bytes: Uint8Array<ArrayBuffer>; filename: string } {
  const sheet =
    view === "clients" ? clientsSheet(payload) : historySheet(payload);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  return {
    bytes: createXlsx(sheet, when),
    filename: `printflow-${view}-${stamp}.xlsx`,
  };
}

function clientsSheet(payload: RecordsPayload): Sheet {
  const { currency } = payload.settings;
  return {
    name: "Clients",
    columns: [
      { header: "Client", width: 26 },
      { header: "Jobs", width: 8 },
      { header: "Completed", width: 11 },
      { header: "Failed", width: 9 },
      { header: "Open", width: 8 },
      { header: "Machine minutes", width: 16 },
      { header: "Filament (g)", width: 13 },
      { header: `Cost${currency ? ` (${currency})` : ""}`, width: 13 },
      { header: "Estimate complete", width: 17 },
      { header: "First job", width: 18 },
      { header: "Last job", width: 18 },
    ],
    rows: payload.clients.map((c) => [
      c.client || "(no client recorded)",
      c.jobs,
      c.completed,
      c.failed,
      c.openJobs,
      Math.round(c.machineMinutes),
      Math.round(c.filamentGrams),
      round2(c.cost),
      c.partial ? "No — some jobs had no file" : "Yes",
      c.firstJobAt ? new Date(c.firstJobAt) : null,
      c.lastJobAt ? new Date(c.lastJobAt) : null,
    ]),
  };
}

function historySheet(payload: RecordsPayload): Sheet {
  const { currency } = payload.settings;
  return {
    name: "Job history",
    columns: [
      { header: "Finished", width: 18 },
      { header: "Client", width: 22 },
      { header: "Job", width: 34 },
      { header: "Status", width: 10 },
      { header: "Printer", width: 16 },
      { header: "Copies", width: 8 },
      { header: "Machine minutes", width: 16 },
      { header: "Filament (g)", width: 13 },
      { header: `Cost${currency ? ` (${currency})` : ""}`, width: 13 },
      { header: "Deadline", width: 18 },
      { header: "Met deadline", width: 13 },
      { header: "Started", width: 18 },
      { header: "Notes", width: 40 },
    ],
    rows: payload.history.map((j) => [
      j.finishedAt ? new Date(j.finishedAt) : null,
      j.client || "(no client recorded)",
      j.title,
      j.status,
      j.printer ?? "",
      j.copies,
      Math.round(j.machineMinutes),
      j.filamentKnown ? Math.round(j.filamentGrams) : null,
      round2(j.cost),
      j.deadline ? new Date(j.deadline) : null,
      j.metDeadline === null ? "" : j.metDeadline ? "Yes" : "No",
      j.startedAt ? new Date(j.startedAt) : null,
      j.notes ?? "",
    ]),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
