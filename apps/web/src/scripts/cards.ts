import {
  URGENCY_LABEL,
  checkCompatibility,
  deadlineUrgency,
  formatDuration,
  jobTotalMin,
  printerModelLabel,
  type JobWithDetails,
  type Printer,
} from "@bambu-organize/shared";

/**
 * Card markup, shared by every lane on the board.
 *
 * Cards are built in the browser rather than server-rendered per lane: the
 * board re-renders after every drop, so having one builder means a job looks
 * identical wherever it lands, and there is no second copy of the markup to
 * drift.
 */

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string,
  );
}

export function thumbnailUrl(job: JobWithDetails): string | null {
  if (!job.fileId || !job.plate) return null;
  if (!job.plate.hasThumbnail) return null;
  return `/api/files/${job.fileId}/plates/${job.plate.plateIndex}/thumbnail`;
}

/** Filament swatches, deduplicated by colour so a 4-colour print reads at a glance. */
function filamentChips(job: JobWithDetails): string {
  if (job.filaments.length === 0) return "";
  const chips = job.filaments
    .map((filament) => {
      const color = filament.colorHex ?? "#666666";
      const label = [filament.type, filament.usedG ? `${Math.round(filament.usedG)}g` : null]
        .filter(Boolean)
        .join(" ");
      return `<span class="tag" title="${escapeHtml(`Slot ${filament.filamentIndex}: ${label || "unknown"}`)}"><span class="swatch" style="background:${escapeHtml(color)}"></span>${escapeHtml(label)}</span>`;
    })
    .join("");
  return `<div class="card-filaments">${chips}</div>`;
}

/** The badges that explain *why* a card looks the way it does. */
function badges(job: JobWithDetails, printers: Printer[]): string {
  const out: string[] = [];

  out.push(
    job.estimateSource === "file"
      ? `<span class="tag file" title="Print time read from the .3mf">from file</span>`
      : job.estimateSource === "printer"
        ? `<span class="tag file" title="Live remaining time from the printer">live</span>`
        : `<span class="tag manual" title="Duration typed in by hand">manual</span>`,
  );

  if (job.copies > 1) out.push(`<span class="tag">×${job.copies}</span>`);
  if (job.priority > 0) out.push(`<span class="tag warn">rush</span>`);

  if (job.plate?.supportUsed) out.push(`<span class="tag" title="Sliced with supports">supports</span>`);

  if (job.deadline) {
    const due = new Date(job.deadline);
    const overdue = due.getTime() < Date.now();
    out.push(
      `<span class="tag ${overdue ? "danger" : ""}" title="Deadline">due ${escapeHtml(
        due.toLocaleDateString([], { month: "short", day: "numeric" }),
      )}</span>`,
    );
  }

  // A plate sliced for another machine will not print correctly, but it is a
  // warning rather than a block - the user may be about to re-slice it.
  const printer = job.printerId ? printers.find((p) => p.id === job.printerId) : undefined;
  if (job.plate && printer) {
    const { model, nozzle } = checkCompatibility(job.plate, printer);
    if (model === "mismatch") {
      out.push(
        `<span class="tag danger" title="Sliced for ${escapeHtml(printerModelLabel(job.plate.printerModelCode))}, assigned to a ${escapeHtml(printerModelLabel(printer.modelCode))}">wrong model</span>`,
      );
    }
    if (nozzle === "mismatch") {
      out.push(
        `<span class="tag warn" title="Sliced for a ${escapeHtml(job.plate.nozzleDiameters ?? "?")}mm nozzle">nozzle ${escapeHtml(job.plate.nozzleDiameters ?? "?")}</span>`,
      );
    }
  } else if (job.plate?.printerModelCode && !printer) {
    out.push(
      `<span class="tag" title="Sliced for this machine">${escapeHtml(printerModelLabel(job.plate.printerModelCode))}</span>`,
    );
  }

  return out.join("");
}

export interface CardOptions {
  /** Buttons rendered in the card's action row, as `[label, action, title]` */
  actions: Array<[string, string, string]>;
  printers: Printer[];
  /** Extra line under the meta row, e.g. a projected start time */
  footnote?: string;
  /**
   * `compact` is the inbox: parked work, not today's plan. Smaller, quieter,
   * and without the queue's ceremony, so the two rows never read as the same
   * kind of thing.
   */
  size?: "normal" | "large" | "compact";
  /**
   * Colour the card's edge by how close its deadline is. Used in the inbox,
   * where nothing else conveys urgency - queued cards get the stronger
   * at-risk signal from the projected schedule instead, which accounts for
   * everything ahead of them rather than the clock alone.
   */
  flagDeadline?: boolean;
  /** Marks the head of the queue - the print that goes on next. */
  isNext?: boolean;
}

export function renderCard(job: JobWithDetails, options: CardOptions): string {
  const thumb = thumbnailUrl(job);
  const total = jobTotalMin(job);
  const printer = job.printerId ? options.printers.find((p) => p.id === job.printerId) : undefined;
  const urgency = options.flagDeadline ? deadlineUrgency(job.deadline, jobTotalMin(job)) : "none";

  const actions = options.actions
    .map(
      ([label, action, title]) =>
        `<button class="ghost" data-action="${action}" data-job-id="${job.id}" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`,
    )
    .join("");

  return `
    <article
      class="card ${options.size === "large" ? "card-large" : ""} ${
        options.size === "compact" ? "card-compact" : ""
      } ${
        options.flagDeadline ? `flag-${urgency}` : ""
      } ${options.isNext ? "is-next" : ""}"
      draggable="true"
      data-job-id="${job.id}"
      ${options.flagDeadline && urgency !== "none" ? `title="${escapeHtml(URGENCY_LABEL[urgency])}"` : ""}
    >
      ${options.isNext ? `<span class="next-badge">Next up</span>` : ""}
      <div class="card-thumb">${
        thumb
          ? `<img src="${thumb}" alt="" loading="lazy" />`
          : `<span class="card-thumb-empty">${job.plate ? `P${job.plate.plateIndex}` : "—"}</span>`
      }</div>
      <div class="card-main">
        <div class="card-title" title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</div>
        <div class="card-meta">
          <span class="mono duration" title="${escapeHtml(
            `${formatDuration(job.estimatedMin * job.copies)} print + ${job.bufferMin}m changeover`,
          )}">${escapeHtml(formatDuration(total))}</span>
          ${job.plate?.weightG ? `<span class="mono dim">${Math.round(job.plate.weightG * job.copies)}g</span>` : ""}
          ${printer ? `<span class="dim">${escapeHtml(printer.name)}</span>` : ""}
        </div>
        <div class="card-badges">${badges(job, options.printers)}</div>
        ${filamentChips(job)}
        ${options.footnote ? `<div class="card-footnote">${options.footnote}</div>` : ""}
      </div>
      <div class="card-actions">${actions}</div>
    </article>
  `;
}
