import {
  PRINTER_MODELS,
  formatClock,
  formatDuration,
  lookupPrinterModel,
  printerModelLabel,
  promiseFinish,
  type FilePlate,
  type PlateFilament,
  type PrintFile,
  type Printer,
} from "@bambu-organize/shared";
import { api, toast } from "./api.js";
import { escapeHtml } from "./cards.js";
import { closest, must, qs, qsa } from "./dom.js";

type PlateWithFilaments = FilePlate & { filaments: PlateFilament[] };
type FileWithPlates = PrintFile & { plates: PlateWithFilaments[] };

interface UploadResponse {
  file: PrintFile;
  plates: PlateWithFilaments[];
  metadata: { warnings: string[] };
  deduped: boolean;
}

interface IntakeData {
  printers: Printer[];
  files: FileWithPlates[];
  /** Enough of the queue to answer "when could I promise this?" locally. */
  schedule: { anchorIso: string; queuedMinutes: number };
}

let state: IntakeData = {
  printers: [],
  files: [],
  schedule: { anchorIso: new Date().toISOString(), queuedMinutes: 0 },
};
/** Plate ids ticked in the upload result, keyed so a re-render keeps the selection. */
const selectedPlates = new Set<string>();

export function initIntake(initial: IntakeData): void {
  state = initial;
  renderPrinterOptions();
  renderFiles();
  wireUpload();
  wireForms();
  wirePromise();
  updateManualPromise();
  renderPrinters();
  renderModelOptions();
  wirePrinterForm();
}

// --- promise dates ----------------------------------------------------------

/**
 * "If you accept this now, when is it ready?"
 *
 * The single number the client-facing person needs before agreeing a date, and
 * the one thing a spreadsheet cannot produce: it depends on everything already
 * committed to the machine. Computed locally from the queue length handed over
 * at page load, so it updates as the form is typed into rather than after a
 * round trip.
 */
function renderPromise(container: HTMLElement, minutes: number): void {
  const queued = qs("[data-promise-queued]", container);
  const rushed = qs("[data-promise-rushed]", container);
  if (!queued) return;

  if (!Number.isFinite(minutes) || minutes <= 0) {
    queued.textContent = "—";
    if (rushed) rushed.textContent = "";
    return;
  }

  const anchor = new Date(state.schedule.anchorIso);
  const { ifQueued, ifRushed } = promiseFinish(anchor, state.schedule.queuedMinutes, minutes);

  queued.textContent = formatClock(ifQueued);
  if (rushed) {
    // Only worth showing when jumping the queue actually buys something.
    const saves = ifQueued.getTime() - ifRushed.getTime();
    rushed.textContent =
      saves > 60_000
        ? `· ${formatClock(ifRushed)} if it jumps the queue (${formatDuration(saves / 60_000)} sooner)`
        : "";
  }
}

function manualFormMinutes(form: HTMLFormElement): number {
  const data = new FormData(form);
  const hours = Number(data.get("hours") ?? 0);
  const minutes = Number(data.get("minutes") ?? 0);
  const copies = Math.max(1, Number(data.get("copies") ?? 1));
  const buffer = Number(data.get("bufferMin") ?? 0);
  return (hours * 60 + minutes) * copies + buffer;
}

function updateManualPromise(): void {
  const form = qs<HTMLFormElement>("[data-manual-form]");
  const container = qs('[data-promise="manual"]');
  if (form && container) renderPromise(container, manualFormMinutes(form));
}

function wirePromise(): void {
  qs<HTMLFormElement>("[data-manual-form]")?.addEventListener("input", updateManualPromise);
}

// --- upload -----------------------------------------------------------------

function wireUpload(): void {
  const dropzone = must("[data-dropzone]");
  const input = must<HTMLInputElement>("[data-file-input]");

  dropzone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) void upload(file);
    input.value = "";
  });

  for (const type of ["dragenter", "dragover"]) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add("drop-target");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove("drop-target");
    });
  }
  dropzone.addEventListener("drop", (event) => {
    const file = (event as DragEvent).dataTransfer?.files?.[0];
    if (file) void upload(file);
  });
}

async function upload(file: File): Promise<void> {
  const status = must("[data-upload-status]");
  status.textContent = `Reading ${file.name}…`;

  const form = new FormData();
  form.append("file", file);

  try {
    const result = await api<UploadResponse>("/api/files", { method: "POST", body: form });
    status.textContent = result.deduped
      ? `${result.file.filename} was already uploaded — showing the existing plates.`
      : `${result.file.filename} · ${result.plates.length} plate(s) read.`;

    for (const warning of result.metadata.warnings) toast(warning, "error");

    selectedPlates.clear();
    for (const plate of result.plates) {
      if (plate.predictionSec != null) selectedPlates.add(plate.id);
    }

    // Put the new file at the top of the library and open its plate picker.
    state.files = [
      { ...result.file, plates: result.plates },
      ...state.files.filter((f) => f.id !== result.file.id),
    ];
    renderFiles(result.file.id);
  } catch (error) {
    status.textContent = "";
    toast((error as Error).message, "error");
  }
}

// --- file library -----------------------------------------------------------

function renderFiles(expandFileId?: string): void {
  const container = must("[data-files]");

  if (state.files.length === 0) {
    container.innerHTML = `<div class="empty">No files yet. Drop a .3mf above to pull its print time, filament and printer model straight out of the slicer's own metadata.</div>`;
    return;
  }

  container.innerHTML = state.files
    .map((file) => {
      const open = file.id === expandFileId;
      const totalSec = file.plates.reduce((sum, plate) => sum + (plate.predictionSec ?? 0), 0);
      return `
        <details class="file" ${open ? "open" : ""} data-file-id="${file.id}">
          <summary>
            <span class="file-name">${escapeHtml(file.filename)}</span>
            <span class="tag ${file.kind === "sliced" ? "file" : ""}">${file.kind}</span>
            <span class="dim mono">${file.plateCount} plate${file.plateCount === 1 ? "" : "s"}</span>
            <span class="dim mono">${escapeHtml(formatDuration(totalSec / 60))}</span>
            <span class="spacer"></span>
            <button class="ghost danger" data-delete-file="${file.id}" title="Delete file and its plates">✕</button>
          </summary>
          <div class="plates">
            ${file.plates.map((plate) => renderPlate(file, plate)).join("")}
          </div>
          <div class="plate-form">
            <!--
              None of these exist anywhere in a .3mf - the format describes the
              print, not the job around it. They are captured here and applied
              to every selected plate, which matches how work actually arrives:
              one client, one due date, several plates.
            -->
            <div class="field">
              <label>Requested by</label>
              <input data-batch-requested-by placeholder="Client or colleague" />
            </div>
            <div class="field">
              <label>Deadline</label>
              <input data-batch-deadline type="datetime-local" />
            </div>
            <div class="field">
              <label>Printer</label>
              <select data-target-printer></select>
            </div>
            <div class="field">
              <label>Goes to</label>
              <select data-target-status>
                <option value="backlog">Inbox</option>
                <option value="queued">Queue</option>
              </select>
            </div>
            <div class="field span-all">
              <label>Notes</label>
              <input data-batch-notes placeholder="Colour, finish, delivery — anything the file cannot say" />
            </div>
            <div class="promise span-all" data-promise="batch">
              <span class="promise-label">Selected plates ready</span>
              <span class="promise-value mono" data-promise-queued>—</span>
              <span class="promise-alt" data-promise-rushed></span>
            </div>
            <div class="plate-form-actions span-all">
              <label class="checkbox">
                <input type="checkbox" data-batch-rush />
                <span>Rush</span>
              </label>
              <span class="spacer"></span>
              <button class="primary" data-create-jobs="${file.id}">Create jobs from selected plates</button>
            </div>
          </div>
        </details>
      `;
    })
    .join("");

  renderPrinterOptions();
}

/** Ticking plates changes how much work is being committed, so the date moves. */
function updateBatchPromises(): void {
  for (const details of qsa("details.file")) {
    const fileId = details.dataset.fileId;
    const container = qs('[data-promise="batch"]', details);
    const file = state.files.find((f) => f.id === fileId);
    if (!container || !file) continue;

    const buffer = Number(qs<HTMLInputElement>("[data-batch-buffer]", details)?.value ?? 15);
    const minutes = file.plates
      .filter((plate) => selectedPlates.has(plate.id) && plate.predictionSec != null)
      .reduce((sum, plate) => sum + Math.max(1, Math.round(plate.predictionSec! / 60)) + buffer, 0);
    renderPromise(container, minutes);
  }
}

function renderPlate(file: FileWithPlates, plate: PlateWithFilaments): string {
  const usable = plate.predictionSec != null;
  const checked = selectedPlates.has(plate.id) ? "checked" : "";
  const thumb = plate.hasThumbnail
    ? `<img src="/api/files/${file.id}/plates/${plate.plateIndex}/thumbnail" alt="" loading="lazy" />`
    : `<span class="card-thumb-empty">P${plate.plateIndex}</span>`;

  const filaments = plate.filaments
    .map(
      (filament) =>
        `<span class="tag"><span class="swatch" style="background:${escapeHtml(
          filament.colorHex ?? "#666",
        )}"></span>${escapeHtml(
          [filament.type, filament.usedG ? `${filament.usedG.toFixed(1)}g` : null]
            .filter(Boolean)
            .join(" ") || `slot ${filament.filamentIndex}`,
        )}</span>`,
    )
    .join("");

  return `
    <label class="plate ${usable ? "" : "plate-unusable"}">
      <input type="checkbox" data-plate="${plate.id}" ${checked} ${usable ? "" : "disabled"} />
      <span class="plate-thumb">${thumb}</span>
      <span class="plate-body">
        <span class="plate-title">${escapeHtml(plate.name || `Plate ${plate.plateIndex}`)}</span>
        <span class="plate-meta">
          <span class="mono">${
            usable ? escapeHtml(formatDuration(plate.predictionSec! / 60)) : "no estimate"
          }</span>
          ${plate.weightG ? `<span class="mono dim">${plate.weightG.toFixed(1)}g</span>` : ""}
          <span class="dim">${escapeHtml(printerModelLabel(plate.printerModelCode))}</span>
          ${plate.nozzleDiameters ? `<span class="dim mono">${escapeHtml(plate.nozzleDiameters)}mm</span>` : ""}
          ${plate.objectCount ? `<span class="dim">${plate.objectCount} object${plate.objectCount === 1 ? "" : "s"}</span>` : ""}
          ${plate.supportUsed ? `<span class="tag">supports</span>` : ""}
          ${plate.gcodePath ? `<span class="tag file" title="This plate carries gcode and could be sent to a printer directly">gcode</span>` : ""}
        </span>
        <span class="card-filaments">${filaments}</span>
      </span>
    </label>
  `;
}

// --- forms ------------------------------------------------------------------

function wireForms(): void {
  must<HTMLFormElement>("[data-manual-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    void submitManualJob(event.currentTarget as HTMLFormElement);
  });

  document.addEventListener("change", (event) => {
    const checkbox = closest<HTMLInputElement>(event.target, "[data-plate]");
    if (!checkbox) return;
    const plateId = checkbox.dataset.plate!;
    if (checkbox.checked) selectedPlates.add(plateId);
    else selectedPlates.delete(plateId);
    updateBatchPromises();
  });

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const createBtn = closest(target, "[data-create-jobs]");
    if (createBtn) {
      void createJobsFromFile(createBtn.dataset.createJobs!, createBtn.closest("details")!);
      return;
    }

    const deleteFile = closest(target, "[data-delete-file]");
    if (deleteFile) {
      event.preventDefault();
      void removeFile(deleteFile.dataset.deleteFile!);
      return;
    }
  });
}

async function submitManualJob(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const hours = Number(data.get("hours") ?? 0);
  const minutes = Number(data.get("minutes") ?? 0);
  const estimatedMin = Math.round(hours * 60 + minutes);

  if (estimatedMin < 1) {
    toast("Give the job a duration — that is what the queue schedules on.", "error");
    return;
  }

  const deadlineRaw = String(data.get("deadline") ?? "");

  try {
    await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        title: String(data.get("title") ?? "").trim(),
        notes: String(data.get("notes") ?? "").trim() || null,
        printerId: String(data.get("printerId") ?? "") || null,
        estimatedMin,
        copies: Number(data.get("copies") ?? 1),
        bufferMin: Number(data.get("bufferMin") ?? 15),
        priority: data.get("rush") ? 1 : 0,
        deadline: deadlineRaw ? new Date(deadlineRaw).toISOString() : null,
        requestedBy: String(data.get("requestedBy") ?? "").trim() || null,
        status: String(data.get("status") ?? "backlog"),
      }),
    });
    form.reset();
    toast("Job added.");
  } catch (error) {
    toast((error as Error).message, "error");
  }
}

async function createJobsFromFile(fileId: string, container: HTMLElement): Promise<void> {
  const file = state.files.find((f) => f.id === fileId);
  if (!file) return;

  const plateIndexes = file.plates
    .filter((plate) => selectedPlates.has(plate.id))
    .map((plate) => plate.plateIndex);
  if (plateIndexes.length === 0) {
    toast("Tick at least one plate first.", "error");
    return;
  }

  const printerId = qs<HTMLSelectElement>("[data-target-printer]", container)?.value || null;
  const status = qs<HTMLSelectElement>("[data-target-status]", container)?.value ?? "backlog";
  const requestedBy = qs<HTMLInputElement>("[data-batch-requested-by]", container)?.value.trim();
  const notes = qs<HTMLInputElement>("[data-batch-notes]", container)?.value.trim();
  const deadlineRaw = qs<HTMLInputElement>("[data-batch-deadline]", container)?.value;
  const rush = qs<HTMLInputElement>("[data-batch-rush]", container)?.checked ?? false;

  try {
    const result = await api<{ jobs: unknown[]; skipped: number[] }>("/api/jobs/from-file", {
      method: "POST",
      body: JSON.stringify({
        fileId,
        plateIndexes,
        printerId,
        status,
        requestedBy: requestedBy || null,
        notes: notes || null,
        deadline: deadlineRaw ? new Date(deadlineRaw).toISOString() : null,
        priority: rush ? 1 : 0,
      }),
    });
    toast(
      `Created ${result.jobs.length} job${result.jobs.length === 1 ? "" : "s"}${
        result.skipped.length ? ` (skipped ${result.skipped.length} plate(s) with no estimate)` : ""
      }.`,
    );
  } catch (error) {
    toast((error as Error).message, "error");
  }
}

async function removeFile(fileId: string): Promise<void> {
  const file = state.files.find((f) => f.id === fileId);
  if (!file) return;
  if (!confirm(`Delete ${file.filename}? Jobs made from it keep their durations but lose the preview.`)) {
    return;
  }
  try {
    await api(`/api/files/${fileId}`, { method: "DELETE" });
    state.files = state.files.filter((f) => f.id !== fileId);
    renderFiles();
  } catch (error) {
    toast((error as Error).message, "error");
  }
}

/**
 * Every "assign to printer" dropdown on the page, kept in sync from one place.
 * Intake does not manage printers - it only assigns to them - so this reads
 * the list handed over at page load and never mutates it.
 */
function renderPrinterOptions(): void {
  const options = [
    `<option value="">Any printer</option>`,
    ...state.printers.map(
      (printer) => `<option value="${printer.id}">${escapeHtml(printer.name)}</option>`,
    ),
  ].join("");

  for (const select of qsa<HTMLSelectElement>(
    '[data-target-printer], select[name="printerId"]',
  )) {
    const previous = select.value;
    select.innerHTML = options;
    select.value = previous;
  }
}

// --- printers ---------------------------------------------------------------

/**
 * The machine registry. It had its own page for a while; it is one short form
 * and a list, and splitting "set up the work" across two pages bought nothing.
 */
function renderPrinters(): void {
  const container = qs("[data-printers]");
  if (!container) return;

  container.innerHTML = state.printers.length
    ? state.printers.map(renderPrinter).join("")
    : `<div class="empty">No printers yet. Add one below so jobs can be assigned to a machine.</div>`;

  const count = qs("[data-printer-count]");
  if (count) count.textContent = String(state.printers.length);
}

function renderPrinter(printer: Printer): string {
  const model = lookupPrinterModel(printer.modelCode);
  const specs = [
    `<span class="tag">${escapeHtml(printerModelLabel(printer.modelCode))}</span>`,
    `<span class="dim mono">${printer.nozzleDiameterMm}mm</span>`,
    model?.bed ? `<span class="dim mono">${model.bed.x}×${model.bed.y}×${model.bed.z}</span>` : "",
    printer.extruderCount > 1 ? `<span class="tag">${printer.extruderCount} extruders</span>` : "",
    printer.hasAms ? `<span class="tag">AMS</span>` : "",
    printer.ipAddress ? `<span class="dim mono">${escapeHtml(printer.ipAddress)}</span>` : "",
  ]
    .filter(Boolean)
    .join("");

  return `
    <div class="printer-row">
      <span class="printer-name">${escapeHtml(printer.name)}</span>
      ${specs}
      <span class="spacer"></span>
      <button class="ghost danger" data-delete-printer="${printer.id}" title="Remove printer">✕</button>
    </div>`;
}

function renderModelOptions(): void {
  const select = qs<HTMLSelectElement>("[data-model-select]");
  if (!select) return;
  select.innerHTML = PRINTER_MODELS.map(
    (model) =>
      `<option value="${model.code}">${escapeHtml(model.name)} (${escapeHtml(model.code)})</option>`,
  ).join("");
}

function wirePrinterForm(): void {
  const form = qs<HTMLFormElement>("[data-printer-form]");
  if (!form) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitPrinter(event.currentTarget as HTMLFormElement);
  });

  // Picking a known model fills in what the catalogue already tells us.
  const modelSelect = qs<HTMLSelectElement>("[data-model-select]", form);
  modelSelect?.addEventListener("change", () => {
    const model = PRINTER_MODELS.find((m) => m.code === modelSelect.value);
    if (!model) return;
    const extruders = qs<HTMLInputElement>('[name="extruderCount"]', form);
    if (extruders) extruders.value = String(model.extruders);
    const name = qs<HTMLInputElement>('[name="name"]', form);
    if (name && !name.value) name.value = model.short;
  });

  document.addEventListener("click", (event) => {
    const button = closest(event.target, "[data-delete-printer]");
    if (button) void removePrinter(button.dataset.deletePrinter!);
  });
}

async function submitPrinter(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  try {
    const printer = await api<Printer>("/api/printers", {
      method: "POST",
      body: JSON.stringify({
        name: String(data.get("name") ?? "").trim(),
        modelCode: String(data.get("modelCode") ?? ""),
        serialNumber: String(data.get("serialNumber") ?? "").trim() || null,
        nozzleDiameterMm: Number(data.get("nozzleDiameterMm") ?? 0.4),
        extruderCount: Number(data.get("extruderCount") ?? 1),
        hasAms: Boolean(data.get("hasAms")),
        ipAddress: String(data.get("ipAddress") ?? "").trim() || null,
      }),
    });
    state.printers = [...state.printers, printer];
    form.reset();
    renderPrinters();
    renderPrinterOptions();
    toast(`${printer.name} registered.`);
  } catch (error) {
    toast((error as Error).message, "error");
  }
}

async function removePrinter(printerId: string): Promise<void> {
  const printer = state.printers.find((p) => p.id === printerId);
  if (!printer) return;
  if (!confirm(`Remove ${printer.name}? Its jobs become unassigned rather than being deleted.`)) {
    return;
  }
  try {
    await api(`/api/printers/${printerId}`, { method: "DELETE" });
    state.printers = state.printers.filter((p) => p.id !== printerId);
    renderPrinters();
    renderPrinterOptions();
  } catch (error) {
    toast((error as Error).message, "error");
  }
}
