import {
  jobTotalMin,
  type Job,
  type JobStatus,
  type JobWithDetails,
  type PrinterStatus,
} from "./types.js";

export interface ScheduledSlot {
  job: JobWithDetails;
  start: Date;
  end: Date;
  /** True when the projected end misses the job's own deadline */
  atRisk: boolean;
}

/**
 * Projects start/end times for a printer's committed queue.
 *
 * The clock starts at `anchor`, which is whichever of these we know:
 *   - the live remaining time of the in-progress print (best),
 *   - the in-progress job's own estimate counted from when it started,
 *   - now, if the machine is idle.
 *
 * Only `queued` jobs get slots; the running job is rendered on its own card
 * and is represented here purely as the offset it pushes everything else by.
 * Nothing about this projection is persisted - it is recomputed on render, so
 * it stays correct as the printer runs ahead of or behind the estimate.
 */
export function computeQueueTimeline(
  jobs: JobWithDetails[],
  anchor: Date = new Date(),
): ScheduledSlot[] {
  const queued = jobs
    .filter((job) => job.status === "queued")
    .sort((a, b) => a.position - b.position);

  let cursorMs = anchor.getTime();
  return queued.map((job) => {
    const start = new Date(cursorMs);
    cursorMs += jobTotalMin(job) * 60_000;
    const end = new Date(cursorMs);
    return { job, start, end, atRisk: missesDeadline(job, end) };
  });
}

/**
 * When the printer frees up. Falls back through live telemetry -> the running
 * job's own estimate -> now, so the board still projects sensible times before
 * the MQTT bridge exists.
 */
export function queueAnchor(
  jobs: Job[],
  status?: PrinterStatus | null,
  now: Date = new Date(),
): Date {
  if (status?.remainingMin != null && status.remainingMin >= 0) {
    return new Date(now.getTime() + status.remainingMin * 60_000);
  }

  const running = jobs.find((job) => job.status === "printing");
  if (running?.startedAt) {
    const projectedEnd = new Date(running.startedAt).getTime() + jobTotalMin(running) * 60_000;
    // A print that has overrun its estimate anchors at "now", not in the past.
    return new Date(Math.max(projectedEnd, now.getTime()));
  }
  if (running) return new Date(now.getTime() + jobTotalMin(running) * 60_000);

  return now;
}

function missesDeadline(job: Job, end: Date): boolean {
  if (!job.deadline) return false;
  return end.getTime() > new Date(job.deadline).getTime();
}

/**
 * How urgent a job's deadline is, measured against the *slack* left after the
 * print itself - not against the raw clock.
 *
 * A 4-hour print due tomorrow at 21:00 stops being comfortable at 17:00 today,
 * not at 21:00 today: you need the 24-hour window *plus* the four hours of
 * machine time. So every band is `threshold + how long the job takes`, and the
 * quantity actually being bucketed is:
 *
 *     slack = (deadline - now) - jobDuration
 *
 * Thresholds are in hours of slack. `none` is deliberately not `safe`: a job
 * with no deadline isn't on track, it simply has no target.
 */
export type DeadlineUrgency = "overdue" | "imminent" | "soon" | "safe" | "longterm" | "none";

export const IMMINENT_SLACK_HOURS = 24;
export const SOON_SLACK_HOURS = 72;
export const SAFE_SLACK_HOURS = 168;

export function deadlineUrgency(
  deadline: string | null | undefined,
  jobMinutes = 0,
  now: Date = new Date(),
): DeadlineUrgency {
  if (!deadline) return "none";
  const due = new Date(deadline).getTime();
  if (Number.isNaN(due)) return "none";

  const minutesLeft = (due - now.getTime()) / 60_000;
  if (minutesLeft < 0) return "overdue";

  // Not enough time left to physically print it. The deadline has not passed
  // yet, but it is already unreachable, so it reads as overdue rather than
  // merely imminent - an amber chip on an impossible job would be a lie.
  const slackHours = (minutesLeft - jobMinutes) / 60;
  if (slackHours < 0) return "overdue";

  if (slackHours <= IMMINENT_SLACK_HOURS) return "imminent";
  if (slackHours <= SOON_SLACK_HOURS) return "soon";
  if (slackHours <= SAFE_SLACK_HOURS) return "safe";
  return "longterm";
}

export const URGENCY_LABEL: Record<DeadlineUrgency, string> = {
  overdue: "Overdue or unachievable",
  imminent: "Under 24h of slack",
  soon: "Under 3 days of slack",
  safe: "Under 7 days of slack",
  longterm: "More than 7 days of slack",
  none: "No deadline",
};

/** Backlog order: rush first, then nearest deadline, then the user's manual order. */
export function sortBacklog(jobs: JobWithDetails[]): JobWithDetails[] {
  return jobs
    .filter((job) => job.status === "backlog")
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      const aDue = a.deadline ? new Date(a.deadline).getTime() : Infinity;
      const bDue = b.deadline ? new Date(b.deadline).getTime() : Infinity;
      if (aDue !== bDue) return aDue - bDue;
      return a.position - b.position;
    });
}

/** Total machine time still ahead of us, in minutes. */
export function queuedMinutes(jobs: Job[]): number {
  return jobs
    .filter((job) => job.status === "queued")
    .reduce((sum, job) => sum + jobTotalMin(job), 0);
}

/** "4h 32m", "45m", "2d 3h" - used everywhere a duration is shown. */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins.toString().padStart(2, "0")}m`;
  return `${mins}m`;
}

/** Wall-clock label, with a day marker once the queue runs past today. */
export function formatClock(date: Date, reference: Date = new Date()): string {
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dayDelta = Math.round(
    (startOfDay(date).getTime() - startOfDay(reference).getTime()) / 86_400_000,
  );
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `${time} tomorrow`;
  return `${time} +${dayDelta}d`;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

// --- deadline pressure ------------------------------------------------------

/**
 * How much room a queued job has left before it breaks its promise.
 *
 * This is the thing a spreadsheet cannot do. A due-date column tells you *that*
 * a job is due Thursday; it cannot tell you that with 14 hours of work already
 * ahead of it, Thursday stops being possible once one more job goes in front.
 *
 * `latestSafePosition` is found by walking the queue with the job removed and
 * asking how many jobs can sit ahead of it before its own finish time crosses
 * its deadline. Durations are positive, so the running total only increases and
 * the search can stop at the first position that fails.
 */
export interface DeadlinePressure {
  jobId: string;
  /** Current 0-based position in the committed queue */
  position: number;
  /**
   * Minutes of *additional* work that could be inserted ahead of this job
   * before it misses its deadline. Negative means it already does.
   *
   * This is deliberately measured in time rather than in queue positions. An
   * earlier version reported slack as "how many more jobs fit in front", which
   * silently conflated two different things: a job that is genuinely out of
   * time, and a job that simply happens to be last in a short queue. The
   * latter reported zero slack while having days to spare.
   */
  headroomMin: number;
  /** When it currently misses, how many places it must move up. 0 otherwise. */
  moveUpBy: number;
  /** True when the deadline cannot be met even as the very next print */
  impossible: boolean;
}

/** Below this much headroom, a job is tight enough to be worth flagging. */
export const TIGHT_HEADROOM_MIN = 60;

export function computeDeadlinePressure(
  jobs: Job[],
  anchor: Date = new Date(),
): Map<string, DeadlinePressure> {
  const queued = jobs
    .filter((job) => job.status === "queued")
    .sort((a, b) => a.position - b.position);

  const totals = queued.map((job) => jobTotalMin(job));
  const out = new Map<string, DeadlinePressure>();

  queued.forEach((job, index) => {
    if (!job.deadline) return;
    const budgetMin = (new Date(job.deadline).getTime() - anchor.getTime()) / 60_000;
    const own = totals[index] ?? 0;

    // Work already committed ahead of this job, in the order it will run.
    const workAhead = totals.slice(0, index).reduce((sum, min) => sum + min, 0);
    const headroomMin = budgetMin - workAhead - own;

    // Only when it actually misses is "move up N places" meaningful. Walk the
    // queue with this job lifted out and find the last slot that still fits.
    let moveUpBy = 0;
    let impossible = false;
    if (headroomMin < 0) {
      const others = totals.filter((_, i) => i !== index);
      let ahead = 0;
      let latestSafePosition = -1;
      for (let slot = 0; slot <= others.length; slot++) {
        if (ahead + own <= budgetMin) latestSafePosition = slot;
        else break;
        ahead += others[slot] ?? 0;
      }
      impossible = latestSafePosition < 0;
      moveUpBy = impossible ? 0 : Math.max(0, index - latestSafePosition);
    }

    out.set(job.id, { jobId: job.id, position: index, headroomMin, moveUpBy, impossible });
  });

  return out;
}

/**
 * When a job of `jobMinutes` would be finished if it were accepted right now.
 *
 * Two answers, because they are the two a client-facing person actually needs:
 * `ifQueued` is the honest promise that disrupts nothing, `ifRushed` is what it
 * becomes if this jumps the whole queue. The truth for any given customer is
 * one of those two, and quoting the first is what stops the queue being
 * over-committed.
 */
export function promiseFinish(
  anchor: Date,
  queuedMin: number,
  jobMinutes: number,
): { ifQueued: Date; ifRushed: Date } {
  return {
    ifQueued: new Date(anchor.getTime() + (queuedMin + jobMinutes) * 60_000),
    ifRushed: new Date(anchor.getTime() + jobMinutes * 60_000),
  };
}

/**
 * The display name for a job derived from a file.
 *
 * Plates are called "Plate 1" inside a .3mf, so a board full of jobs from
 * different customers was a wall of identical titles distinguishable only by
 * thumbnail. The client comes first because that is what someone scanning the
 * board or the exported sheet is looking for.
 *
 *   Mohamed Esam (Fidget_Karambit)[Plate 1]
 *
 * With no client it degrades to `Fidget_Karambit [Plate 1]` rather than
 * printing empty brackets.
 */
export function composeJobTitle(parts: {
  requestedBy?: string | null;
  /** Plate name if the user set one in the slicer, else the file stem */
  product?: string | null;
  plateIndex?: number | null;
}): string {
  const client = parts.requestedBy?.trim();
  const product = parts.product?.trim();
  const plate = parts.plateIndex != null ? `[Plate ${parts.plateIndex}]` : "";

  if (client && product) return `${client} (${product})${plate}`;
  if (client) return `${client} ${plate}`.trim();
  if (product) return `${product} ${plate}`.trim();
  return plate || "Untitled job";
}

/** "Fidget_Karambit(A1_Mini).3mf" -> "Fidget_Karambit(A1_Mini)" */
export function fileStem(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}


// --- book-keeping -----------------------------------------------------------

export interface CostSettings {
  currency: string;
  machineRatePerHour: number;
  /** Price per kg keyed by uppercased filament type, e.g. { PLA: 900 } */
  filamentPrices: Record<string, number>;
}

export interface FilamentUse {
  type?: string | null;
  /** Grams for one copy of the plate */
  usedG?: number | null;
}

export interface JobCost {
  filamentGrams: number;
  filamentCost: number;
  machineMinutes: number;
  machineCost: number;
  total: number;
  /** False when the job has no plate, so filament is unknown rather than zero */
  filamentKnown: boolean;
  /** Types that were printed but have no price set - the cost understates by these */
  unpricedTypes: string[];
}

/** Types are matched case-insensitively; the slicer is not consistent about case. */
export function filamentKey(type: string | null | undefined): string {
  return (type ?? "").trim().toUpperCase();
}

/**
 * What a job cost to run.
 *
 * Filament is costed **per type**, not from the plate's total weight: a single
 * price per kilogram only made sense for a workshop that runs one material,
 * and the slicer already records type and grams for every filament on the
 * plate. Machine time is billed on the print itself, not the changeover
 * buffer - the buffer is scheduling slack, not something a customer pays for.
 *
 * A job with no plate reports `filamentKnown: false` rather than a silent
 * zero, and any type printed without a price set is listed in `unpricedTypes`,
 * so a total can say how much of itself it is unsure about.
 */
export function jobCost(
  job: Pick<Job, "estimatedMin" | "copies"> & { filaments?: FilamentUse[] },
  settings: CostSettings,
): JobCost {
  const copies = Math.max(1, job.copies);
  const machineMinutes = job.estimatedMin * copies;
  const machineCost = (machineMinutes / 60) * settings.machineRatePerHour;

  const filaments = job.filaments ?? [];
  let filamentGrams = 0;
  let filamentCost = 0;
  const unpriced = new Set<string>();

  for (const filament of filaments) {
    const grams = (filament.usedG ?? 0) * copies;
    if (grams <= 0) continue;
    filamentGrams += grams;

    const key = filamentKey(filament.type);
    const price = settings.filamentPrices[key] ?? 0;
    if (price > 0) filamentCost += (grams / 1000) * price;
    else unpriced.add(key || "unknown");
  }

  return {
    filamentGrams,
    filamentCost,
    machineMinutes,
    machineCost,
    total: filamentCost + machineCost,
    filamentKnown: filaments.length > 0,
    unpricedTypes: [...unpriced],
  };
}

/** Money for display. Deliberately plain - no locale guessing, no rounding games. */
export function formatMoney(amount: number, currency: string): string {
  const value = Math.round(amount * 100) / 100;
  const text = value.toFixed(2);
  return currency ? `${text} ${currency}` : text;
}

/** Statuses that represent finished work rather than plans. */
export const CLOSED_JOB_STATUSES: readonly JobStatus[] = ["done", "failed", "cancelled"];

export function isClosed(status: JobStatus): boolean {
  return CLOSED_JOB_STATUSES.includes(status);
}
