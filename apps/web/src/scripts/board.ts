import {
  computeDeadlinePressure,
  computeQueueTimeline,
  formatClock,
  formatDuration,
  jobTotalMin,
  printerModelLabel,
  queueAnchor,
  queuedMinutes,
  sortBacklog,
  TIGHT_HEADROOM_MIN,
  type DeadlinePressure,
  type JobStatus,
  type JobWithDetails,
  type Printer,
  type PrinterStatus,
} from "@bambu-organize/shared";
import { api, toast } from "./api.js";
import { escapeHtml, renderCard, thumbnailUrl } from "./cards.js";
import { closest, must, qs, qsa } from "./dom.js";

interface BoardData {
  jobs: JobWithDetails[];
  printers: Printer[];
  statuses: PrinterStatus[];
}

/**
 * Lanes the user can drop into. There is no separate "next up" lane any more -
 * being next is simply being at the head of the queue, so it is a marker on a
 * card rather than a column of its own.
 */
type Lane = "backlog" | "queued" | "printing";

/**
 * Row 2 reads right-to-left into the printer: the queue's rightmost card is
 * the one that goes on next, sitting closest to the "now printing" panel.
 * The lane is `flex-direction: row-reverse`, so DOM order still runs
 * head-first and only the hit-testing has to know about the flip.
 */
type Axis = "vertical" | "horizontal" | "horizontal-reversed";

const PRINTER_FILTER_KEY = "printflow:printer";

let board: BoardData = { jobs: [], printers: [], statuses: [] };
let printerFilter: string | null = null;
let draggingId: string | null = null;

export function initBoard(initial: BoardData): void {
  board = initial;
  printerFilter = localStorage.getItem(PRINTER_FILTER_KEY);
  if (printerFilter && !board.printers.some((p) => p.id === printerFilter)) printerFilter = null;

  renderPrinterFilter();
  render();
  wireGlobalHandlers();

  // Two clocks, deliberately: the countdown ticks every second in place,
  // while the full repaint (projected start times, deadline flags) runs once a
  // minute because nothing in it changes faster than that.
  window.setInterval(tickCountdown, 1000);
  window.setInterval(render, 60_000);
}

// --- selection --------------------------------------------------------------

/**
 * A job with no printer belongs to every machine's view - it is unassigned
 * work, and hiding it behind a filter is how jobs get forgotten.
 */
function visible(job: JobWithDetails): boolean {
  if (!printerFilter) return true;
  return job.printerId === printerFilter || job.printerId == null;
}

function lane(status: JobStatus): JobWithDetails[] {
  return board.jobs
    .filter((job) => job.status === status && visible(job))
    .sort((a, b) => a.position - b.position);
}

function currentStatus(): PrinterStatus | null {
  if (!printerFilter) return board.statuses[0] ?? null;
  return board.statuses.find((status) => status.printerId === printerFilter) ?? null;
}

// --- rendering --------------------------------------------------------------

function render(): void {
  const backlog = sortBacklog(board.jobs.filter(visible));
  const queued = lane("queued");
  const printing = lane("printing");

  const anchor = queueAnchor(board.jobs.filter(visible), currentStatus());
  const timeline = computeQueueTimeline(board.jobs.filter(visible), anchor);
  const pressure = computeDeadlinePressure(board.jobs.filter(visible), anchor);

  renderBacklog(backlog);
  renderQueue(queued, timeline, pressure);
  renderPrinting(printing[0]);
  renderSchedule(timeline, printing[0], anchor);
  renderSummary(queued, anchor);
}

function renderBacklog(jobs: JobWithDetails[]): void {
  const body = qs('[data-lane="backlog"]');
  if (!body) return;
  body.innerHTML = jobs.length
    ? jobs
        .map((job) =>
          renderCard(job, {
            printers: board.printers,
            size: "compact",
            flagDeadline: true,
            actions: [
              ["Queue →", "queue", "Commit to the printer queue"],
              ["✎", "edit", "Edit this job"],
              ["✕", "delete", "Delete this job"],
            ],
          }),
        )
        .join("")
    : `<div class="empty">Nothing waiting. Add a job on the <a href="/intake">intake page</a>, or drag one back here.</div>`;
  must("[data-count-backlog]").textContent = String(jobs.length);
}

function renderQueue(
  jobs: JobWithDetails[],
  timeline: ReturnType<typeof computeQueueTimeline>,
  pressure: Map<string, DeadlinePressure>,
): void {
  const body = qs('[data-lane="queued"]');
  if (!body) return;

  const slotByJob = new Map(timeline.map((slot) => [slot.job.id, slot]));

  body.innerHTML = jobs.length
    ? jobs
        .map((job, index) => {
          const slot = slotByJob.get(job.id);
          const starts = slot
            ? `<span class="dim">starts ${escapeHtml(formatClock(slot.start))}</span>`
            : "";
          return renderCard(job, {
            printers: board.printers,
            isNext: index === 0,
            footnote: `<span class="queue-index">${index + 1}</span>${pressureChip(pressure.get(job.id))}${starts}`,
            actions: [
              ["▶ Start", "start", "Mark as printing now"],
              ["✎", "edit", "Edit this job"],
              ["← Inbox", "backlog", "Send back to the inbox"],
              ["✕", "delete", "Delete this job"],
            ],
          });
        })
        .join("")
    : `<div class="empty">Queue is empty. Drag jobs down from the inbox.</div>`;

  must("[data-count-queued]").textContent = String(jobs.length);
}

/**
 * Turns slack into an instruction.
 *
 * "Misses deadline" tells someone they have a problem; it does not tell them
 * what to do about it. `latestSafePosition` does, and it is the one number a
 * spreadsheet with a due-date column can never produce.
 */
function pressureChip(pressure: DeadlinePressure | undefined): string {
  if (!pressure) return "";

  if (pressure.impossible) {
    return `<span class="chip chip-hard" title="Even printing this next, it finishes after the deadline. The date needs re-agreeing.">can't make it</span>`;
  }

  if (pressure.headroomMin < 0) {
    const places = pressure.moveUpBy;
    const late = formatDuration(-pressure.headroomMin);
    return `<span class="chip chip-hard" title="Finishes ${escapeHtml(late)} after its deadline. Moving it up ${places} place${places === 1 ? "" : "s"} fixes it.">move up ${places}</span>`;
  }

  // Headroom is "how much more work could go in front of this", which is the
  // question someone slotting a new job in actually has.
  const spare = formatDuration(pressure.headroomMin);
  if (pressure.headroomMin < TIGHT_HEADROOM_MIN) {
    return `<span class="chip chip-warn" title="Only ${escapeHtml(spare)} of extra work could go ahead of this before it misses its deadline.">${escapeHtml(spare)} spare</span>`;
  }
  return `<span class="chip chip-ok" title="${escapeHtml(spare)} of extra work could go ahead of this before it misses its deadline.">${escapeHtml(spare)} spare</span>`;
}

/**
 * The running print, and the countdown that is the whole point of this column.
 *
 * `finishAt` is computed once here and then ticked by `startCountdown` every
 * second, rather than re-rendering the card - a full re-render would restart
 * the thumbnail load and make the number visibly stutter.
 *
 * Where the finish time comes from, best first:
 *   1. the printer's own remaining time (phase 4, once telemetry exists),
 *   2. start time plus the slicer's estimate,
 *   3. nothing useful - the job is marked printing but never started.
 */
function renderPrinting(job: JobWithDetails | undefined): void {
  const body = qs('[data-lane="printing"]');
  if (!body) return;

  if (!job) {
    body.innerHTML = `<div class="empty">Idle.<br />Drop a job here when you start it on the machine.</div>`;
    return;
  }

  const status = board.statuses.find((s) => s.printerId === job.printerId) ?? null;
  const totalMs = job.estimatedMin * job.copies * 60_000;
  const now = Date.now();

  let finishAt: number | null;
  let startedAt: number | null;
  let source: string;
  if (status?.remainingMin != null) {
    finishAt = now + status.remainingMin * 60_000;
    startedAt = finishAt - totalMs;
    source = "live from printer";
  } else if (job.startedAt) {
    startedAt = new Date(job.startedAt).getTime();
    finishAt = startedAt + totalMs;
    source = "projected from start time";
  } else {
    startedAt = null;
    finishAt = null;
    source = "marked printing but never started";
  }

  const thumb = thumbnailUrl(job);
  const layers =
    status?.layerNum != null && status.totalLayerNum != null
      ? `<div class="running-stat"><span class="label">Layer</span><span class="mono">${status.layerNum} / ${status.totalLayerNum}</span></div>`
      : "";
  const temps =
    status?.nozzleTempC != null
      ? `<div class="running-stat"><span class="label">Temps</span><span class="mono">${Math.round(status.nozzleTempC)}° / ${Math.round(status.bedTempC ?? 0)}°</span></div>`
      : "";

  body.innerHTML = `
    <div class="running" data-job-id="${job.id}">
      ${thumb ? `<div class="running-thumb"><img src="${thumb}" alt="" /></div>` : ""}

      <div class="countdown"
           data-countdown
           ${finishAt ? `data-finish-at="${finishAt}"` : ""}
           ${startedAt ? `data-started-at="${startedAt}"` : ""}>
        <div class="countdown-time mono" data-countdown-time>--:--:--</div>
        <div class="countdown-label" data-countdown-label>remaining</div>
      </div>

      <div class="progress"><div class="progress-fill" data-countdown-fill style="width:0%"></div></div>

      <div class="running-title">${escapeHtml(job.title)}</div>
      <div class="running-sub">
        ${job.printer ? `<span>${escapeHtml(job.printer.name)}</span><span class="dot"></span>` : ""}
        <span>${escapeHtml(job.plate?.printerModelCode ? printerModelLabel(job.plate.printerModelCode) : "—")}</span>
      </div>

      <div class="running-stats">
        <div class="running-stat">
          <span class="label">Done</span><span class="mono" data-countdown-percent>0%</span>
        </div>
        <div class="running-stat">
          <span class="label">Finishes</span>
          <span class="mono">${finishAt ? escapeHtml(formatClock(new Date(finishAt))) : "—"}</span>
        </div>
        ${layers}
        ${temps}
      </div>

      <div class="running-source">${escapeHtml(source)}</div>
      <div class="running-actions">
        <button data-action="done" data-job-id="${job.id}">✓ Finished</button>
        <button data-action="pause" data-job-id="${job.id}">⏸ Pause</button>
        <button class="danger" data-action="failed" data-job-id="${job.id}">✕ Failed</button>
      </div>
    </div>
  `;

  tickCountdown();
}

/**
 * Updates the countdown in place, once a second. Reads its inputs off the DOM
 * so it survives a board re-render without needing any shared state - if the
 * element is gone, there is nothing to do.
 */
function tickCountdown(): void {
  const root = qs("[data-countdown]");
  if (!root) return;

  const finishAt = Number(root.dataset.finishAt ?? "");
  const startedAt = Number(root.dataset.startedAt ?? "");
  const time = qs("[data-countdown-time]", root);
  const label = qs("[data-countdown-label]", root);
  const fill = qs("[data-countdown-fill]");
  const percentEl = qs("[data-countdown-percent]");
  if (!time || !label) return;

  if (!Number.isFinite(finishAt) || finishAt === 0) {
    time.textContent = "--:--:--";
    label.textContent = "no start time recorded";
    return;
  }

  const remainingMs = finishAt - Date.now();
  const overrun = remainingMs < 0;
  time.textContent = formatCountdown(Math.abs(remainingMs));
  time.classList.toggle("overrun", overrun);
  label.textContent = overrun ? "over estimate" : "remaining";

  if (Number.isFinite(startedAt) && startedAt > 0) {
    const total = finishAt - startedAt;
    const percent = total > 0 ? Math.min(100, Math.max(0, ((Date.now() - startedAt) / total) * 100)) : 0;
    if (fill) fill.style.width = `${percent}%`;
    if (percentEl) percentEl.textContent = `${Math.round(percent)}%`;
  }
}

/** h:mm:ss, dropping the hours segment under an hour. */
function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function renderSchedule(
  timeline: ReturnType<typeof computeQueueTimeline>,
  printing: JobWithDetails | undefined,
  anchor: Date,
): void {
  const body = qs("[data-schedule]");
  if (!body) return;

  if (!printing && timeline.length === 0) {
    body.innerHTML = `<div class="empty">Nothing scheduled.</div>`;
    return;
  }

  const totalMin =
    (printing ? Math.max(0, (anchor.getTime() - Date.now()) / 60_000) : 0) +
    timeline.reduce((sum, slot) => sum + jobTotalMin(slot.job), 0);

  const segments: string[] = [];
  if (printing) {
    const runningMin = Math.max(1, (anchor.getTime() - Date.now()) / 60_000);
    segments.push(
      `<div class="seg running" style="flex:${runningMin}" title="${escapeHtml(
        `${printing.title} — finishes ${formatClock(anchor)}`,
      )}"><span>${escapeHtml(printing.title)}</span></div>`,
    );
  }
  for (const slot of timeline) {
    segments.push(
      `<div class="seg ${slot.atRisk ? "risk" : ""}" style="flex:${jobTotalMin(slot.job)}" title="${escapeHtml(
        `${slot.job.title} — ${formatClock(slot.start)} to ${formatClock(slot.end)}`,
      )}"><span>${escapeHtml(slot.job.title)}</span></div>`,
    );
  }

  const last = timeline.at(-1);
  body.innerHTML = `
    <div class="schedule-bar">${segments.join("")}</div>
    <div class="schedule-legend">
      <span>now</span>
      <span class="spacer"></span>
      <span>${escapeHtml(formatDuration(totalMin))} of work · clear by ${escapeHtml(
        formatClock(last ? last.end : anchor),
      )}</span>
    </div>
  `;
}

function renderSummary(queued: JobWithDetails[], anchor: Date): void {
  const el = qs("[data-summary]");
  if (!el) return;
  const visibleJobs = board.jobs.filter(visible);
  const total = queuedMinutes(visibleJobs);
  const pressure = computeDeadlinePressure(visibleJobs, anchor);
  const breached = [...pressure.values()].filter((p) => p.headroomMin < 0).length;

  // The count of broken promises leads, because it is the only part of this
  // line that anyone has to act on.
  const risk = breached
    ? `<span class="summary-risk">${breached} missing deadline</span> · `
    : "";
  el.innerHTML = `${risk}<span class="mono">${queued.length}</span> queued · <span class="mono">${escapeHtml(
    formatDuration(total),
  )}</span> of work · printer free <span class="mono">${escapeHtml(formatClock(anchor))}</span>`;
}

function renderPrinterFilter(): void {
  const select = qs<HTMLSelectElement>("[data-printer-filter]");
  if (!select) return;
  select.innerHTML = [
    `<option value="">All printers</option>`,
    ...board.printers.map(
      (printer) =>
        `<option value="${printer.id}" ${printer.id === printerFilter ? "selected" : ""}>${escapeHtml(
          printer.name,
        )} · ${escapeHtml(printerModelLabel(printer.modelCode))}</option>`,
    ),
  ].join("");
}

// --- interaction ------------------------------------------------------------

function wireGlobalHandlers(): void {
  const select = qs<HTMLSelectElement>("[data-printer-filter]");
  select?.addEventListener("change", () => {
    printerFilter = select.value || null;
    if (printerFilter) localStorage.setItem(PRINTER_FILTER_KEY, printerFilter);
    else localStorage.removeItem(PRINTER_FILTER_KEY);
    render();
  });

  document.addEventListener("click", (event) => {
    const button = closest(event.target, "[data-action]");
    if (!button) return;
    const jobId = button.dataset.jobId;
    if (!jobId) return;
    void handleAction(button.dataset.action!, jobId);
  });

  for (const zone of qsa("[data-lane]")) {
    wireDropZone(zone, zone.dataset.lane as Lane);
  }

  const editForm = qs<HTMLFormElement>("[data-edit-form]");
  editForm?.addEventListener("submit", (event) => {
    // method="dialog" would close before the request runs, so take over.
    event.preventDefault();
    void submitEdit(event.currentTarget as HTMLFormElement);
  });
  qs("[data-edit-cancel]")?.addEventListener("click", () =>
    qs<HTMLDialogElement>("[data-edit-dialog]")?.close(),
  );

  // Cards are rebuilt on every render, so the drag handlers live on the
  // document rather than on each card.
  document.addEventListener("dragstart", (event) => {
    const card = closest(event.target, ".card");
    if (!card) return;
    draggingId = card.dataset.jobId ?? null;
    card.classList.add("dragging");
    event.dataTransfer?.setData("text/plain", draggingId ?? "");
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });

  document.addEventListener("dragend", () => {
    draggingId = null;
    document.querySelector(".dragging")?.classList.remove("dragging");
    clearPlaceholder();
  });
}

/** The queue reads right-to-left; every other lane reads normally. */
function axisFor(laneName: Lane): Axis {
  if (laneName === "queued") return "horizontal-reversed";
  if (laneName === "backlog") return "horizontal";
  return "vertical";
}

function wireDropZone(zone: HTMLElement, laneName: Lane): void {
  zone.addEventListener("dragover", (event) => {
    if (!draggingId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    zone.classList.add("drop-target");
    if (laneName === "backlog" || laneName === "queued") {
      showPlaceholder(zone, event, axisFor(laneName));
    }
  });

  zone.addEventListener("dragleave", (event) => {
    if (event.relatedTarget && zone.contains(event.relatedTarget as Node)) return;
    zone.classList.remove("drop-target");
  });

  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("drop-target");
    const jobId = draggingId ?? event.dataTransfer?.getData("text/plain");
    clearPlaceholder();
    if (!jobId) return;
    void moveJob(jobId, laneName, zone, event);
  });
}

// --- drop placeholder -------------------------------------------------------

let placeholder: HTMLElement | null = null;

function showPlaceholder(zone: HTMLElement, event: DragEvent, axis: Axis): void {
  if (!placeholder) {
    placeholder = document.createElement("div");
    placeholder.className = "drop-placeholder";
  }
  placeholder.classList.toggle("horizontal", axis !== "vertical");

  const target = cardAtPoint(zone, event, axis);
  if (!target) {
    zone.appendChild(placeholder);
  } else {
    zone.insertBefore(placeholder, target);
  }
}

function clearPlaceholder(): void {
  placeholder?.remove();
  for (const zone of document.querySelectorAll(".drop-target")) {
    zone.classList.remove("drop-target");
  }
}

/**
 * The card the insertion point should go *before* in DOM order, or null to
 * append.
 *
 * DOM order is always queue order, head first. In the reversed lane the head
 * is drawn on the right, so "further along the pointer axis" means *earlier*
 * in the queue - hence the flipped comparison. Getting this wrong silently
 * inverts every drop, so it is the one place the reversal is allowed to leak.
 */
function cardAtPoint(zone: HTMLElement, event: DragEvent, axis: Axis): HTMLElement | null {
  const cards = qsa(".card:not(.dragging)", zone);
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const vertical = axis === "vertical";
    const midpoint = vertical ? box.top + box.height / 2 : box.left + box.width / 2;
    const pointer = vertical ? event.clientY : event.clientX;
    const before = axis === "horizontal-reversed" ? pointer > midpoint : pointer < midpoint;
    if (before) return card;
  }
  return null;
}

// --- editing -----------------------------------------------------------------

/**
 * Editing exists because the alternative was delete-and-recreate, which loses
 * the job's history and its place in the queue. Everything here maps onto the
 * PATCH route that already existed.
 */
function openEditDialog(job: JobWithDetails): void {
  const dialog = qs<HTMLDialogElement>("[data-edit-dialog]");
  const form = qs<HTMLFormElement>("[data-edit-form]");
  if (!dialog || !form) return;

  const set = (name: string, value: string | number | boolean) => {
    const field = qs<HTMLInputElement>(`[name="${name}"]`, form);
    if (!field) return;
    if (typeof value === "boolean") field.checked = value;
    else field.value = String(value);
  };

  set("title", job.title);
  set("requestedBy", job.requestedBy ?? "");
  set("hours", Math.floor(job.estimatedMin / 60));
  set("minutes", job.estimatedMin % 60);
  set("copies", job.copies);
  set("bufferMin", job.bufferMin);
  set("notes", job.notes ?? "");
  set("rush", job.priority > 0);
  // datetime-local wants local wall-clock with no zone, not an ISO string.
  set("deadline", job.deadline ? toLocalInput(new Date(job.deadline)) : "");

  const printerSelect = qs<HTMLSelectElement>('[name="printerId"]', form);
  if (printerSelect) {
    printerSelect.innerHTML = [
      `<option value="">Any printer</option>`,
      ...board.printers.map(
        (printer) => `<option value="${printer.id}">${escapeHtml(printer.name)}</option>`,
      ),
    ].join("");
    printerSelect.value = job.printerId ?? "";
  }

  const hint = qs("[data-edit-hint]");
  if (hint) {
    hint.textContent =
      job.estimateSource === "file"
        ? "Print time came from the .3mf. Changing it marks the estimate as manual."
        : "";
  }

  form.dataset.jobId = job.id;
  dialog.showModal();
  void loadHistory(job.id);
}

interface JobEvent {
  type: string;
  message: string | null;
  createdAt: string;
}

/** Loaded lazily on open - it is a detail view, not something the board needs. */
async function loadHistory(jobId: string): Promise<void> {
  const list = qs("[data-edit-history]");
  if (!list) return;
  list.innerHTML = `<li class="dim">loading…</li>`;

  try {
    const events = await api<JobEvent[]>(`/api/jobs/${jobId}/events`);
    list.innerHTML = events.length
      ? events
          .map(
            (event) => `
              <li>
                <span class="event-when">${escapeHtml(
                  new Date(event.createdAt).toLocaleString([], {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                )}</span>
                <span>${escapeHtml(event.message || event.type.replace(/_/g, " "))}</span>
              </li>`,
          )
          .join("")
      : `<li class="dim">No history recorded.</li>`;
  } catch {
    list.innerHTML = `<li class="dim">Could not load history.</li>`;
  }
}

function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function submitEdit(form: HTMLFormElement): Promise<void> {
  const jobId = form.dataset.jobId;
  if (!jobId) return;
  const data = new FormData(form);

  const estimatedMin = Number(data.get("hours") ?? 0) * 60 + Number(data.get("minutes") ?? 0);
  if (estimatedMin < 1) {
    toast("Print time has to be at least a minute.", "error");
    return;
  }
  const deadlineRaw = String(data.get("deadline") ?? "");

  try {
    await api(`/api/jobs/${jobId}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: String(data.get("title") ?? "").trim(),
        requestedBy: String(data.get("requestedBy") ?? "").trim() || null,
        printerId: String(data.get("printerId") ?? "") || null,
        estimatedMin,
        copies: Number(data.get("copies") ?? 1),
        bufferMin: Number(data.get("bufferMin") ?? 0),
        priority: data.get("rush") ? 1 : 0,
        deadline: deadlineRaw ? new Date(deadlineRaw).toISOString() : null,
        notes: String(data.get("notes") ?? "").trim() || null,
      }),
    });
    board = await api<BoardData>("/api/jobs/board");
    render();
    qs<HTMLDialogElement>("[data-edit-dialog]")?.close();
    toast("Job updated.");
  } catch (error) {
    toast((error as Error).message, "error");
  }
}

// --- mutations --------------------------------------------------------------

async function moveJob(jobId: string, laneName: Lane, zone: HTMLElement, event: DragEvent): Promise<void> {
  const job = board.jobs.find((j) => j.id === jobId);
  if (!job) return;

  const status: JobStatus = laneName;
  let order: string[];

  if (laneName === "printing") {
    order = [];
  } else {
    // DOM order is queue order in every lane, reversed or not, so the list we
    // send is built the same way regardless of which direction it is drawn.
    const existing = qsa(".card", zone)
      .map((card) => card.dataset.jobId!)
      .filter((id) => id !== jobId);
    const before = cardAtPoint(zone, event, axisFor(laneName))?.dataset.jobId;
    const insertAt = before ? existing.indexOf(before) : existing.length;
    order = [...existing.slice(0, insertAt), jobId, ...existing.slice(insertAt)];
  }

  // A printer has to be chosen before a job can run on it; without that the
  // "one print at a time" check on the server has nothing to key off.
  let printerId = job.printerId;
  if (status === "printing" && !printerId) {
    if (printerFilter) {
      printerId = printerFilter;
    } else if (board.printers.length === 1) {
      printerId = board.printers[0]!.id;
    } else if (board.printers.length === 0) {
      toast("Add a printer on the intake page first.", "error");
      return;
    } else {
      toast("Pick a printer in the filter above before starting a job.", "error");
      return;
    }
  }

  await applyMove(jobId, status, printerId ?? null, order);
}

async function handleAction(action: string, jobId: string): Promise<void> {
  const job = board.jobs.find((j) => j.id === jobId);
  if (!job) return;

  switch (action) {
    case "edit":
      openEditDialog(job);
      return;
    case "delete": {
      if (!confirm(`Delete "${job.title}"?`)) return;
      try {
        await api(`/api/jobs/${jobId}`, { method: "DELETE" });
        board.jobs = board.jobs.filter((j) => j.id !== jobId);
        render();
      } catch (error) {
        toast((error as Error).message, "error");
      }
      return;
    }
    case "queue": {
      // Joins the back of the queue - the left edge, furthest from the printer.
      const order = [...lane("queued").map((j) => j.id), jobId];
      await applyMove(jobId, "queued", job.printerId ?? printerFilter ?? null, order);
      return;
    }
    case "backlog": {
      const order = [...lane("backlog").map((j) => j.id), jobId];
      await applyMove(jobId, "backlog", job.printerId ?? null, order);
      return;
    }
    case "start": {
      const printerId = job.printerId ?? printerFilter ?? (board.printers[0]?.id ?? null);
      if (!printerId) {
        toast("Add a printer on the intake page first.", "error");
        return;
      }
      await applyMove(jobId, "printing", printerId, []);
      return;
    }
    // These three leave the board entirely. Nothing is deleted, but without a
    // word about where it went, pausing looks exactly like deleting.
    case "pause":
      await applyMove(jobId, "paused", job.printerId ?? null, []);
      toast("Paused and moved to Records, where it can go back in the queue.");
      return;
    case "done":
    case "failed":
      await applyMove(jobId, action === "done" ? "done" : "failed", job.printerId ?? null, []);
      toast(`Moved to Records as ${action === "done" ? "finished" : "failed"}.`);
      return;
  }
}

async function applyMove(
  jobId: string,
  status: JobStatus,
  printerId: string | null,
  order: string[],
): Promise<void> {
  // Optimistic: the drop already moved the card visually, so repaint from
  // local state first and let the server's board response be the correction.
  const previous = structuredClone(board.jobs);
  const job = board.jobs.find((j) => j.id === jobId);
  if (job) {
    job.status = status;
    job.printerId = printerId;
    order.forEach((id, index) => {
      const target = board.jobs.find((j) => j.id === id);
      if (target) target.position = index;
    });
    render();
  }

  try {
    board = await api<BoardData>("/api/jobs/move", {
      method: "POST",
      body: JSON.stringify({ jobId, status, printerId, order }),
    });
    render();
  } catch (error) {
    board.jobs = previous;
    render();
    toast((error as Error).message, "error");
  }
}
