import { formatDuration, formatMoney, type CostSettings } from "@bambu-organize/shared";
import { api, toast } from "./api.js";
import { escapeHtml } from "./cards.js";
import { closest, must, qs, qsa } from "./dom.js";

/**
 * Book-keeping: what was actually done, for whom, and what it cost.
 *
 * Two readers with different questions, which is why the page has two tables
 * rather than one: whoever handles clients wants "what has this customer had
 * from us", and whoever runs the printer wants "what did we actually run".
 * The same rows answer both, grouped differently.
 */

interface ClientRecord {
  client: string;
  jobs: number;
  completed: number;
  failed: number;
  openJobs: number;
  machineMinutes: number;
  filamentGrams: number;
  cost: number;
  partial: boolean;
  firstJobAt: string | null;
  lastJobAt: string | null;
}

interface JobRecord {
  id: string;
  title: string;
  client: string;
  status: string;
  printer: string | null;
  copies: number;
  machineMinutes: number;
  filamentGrams: number;
  filamentKnown: boolean;
  unpricedTypes: string[];
  cost: number;
  deadline: string | null;
  metDeadline: boolean | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  notes: string | null;
}

interface RecordsPayload {
  settings: CostSettings;
  filamentTypes: string[];
  clients: ClientRecord[];
  history: JobRecord[];
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

let state: RecordsPayload;

/**
 * A window over the history. There is deliberately no "all time":
 * book-keeping is read a period at a time, and an unbounded list is one that
 * gets slower and less useful every month it runs. Anything older than the
 * listed windows is reached through the exports.
 */
interface Scope {
  key: string;
  label: string;
  from: Date;
  /** Exclusive */
  to: Date;
}

let scope: Scope;

export function initRecords(initial: RecordsPayload): void {
  state = initial;
  const { periods } = buildScopes();
  // Land on a fortnight: the smallest window that still shows a shape.
  scope = periods[0]!;
  render();
  wire();
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * Local calendar day, not UTC. A job finished at 01:00 belongs to that day as
 * the workshop lived it, and a UTC key would file it under the previous one.
 */
function dayKey(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function stamp(job: JobRecord): Date {
  return new Date(job.finishedAt ?? job.createdAt);
}

function buildScopes(): { periods: Scope[]; days: Scope[]; earlier: Scope[] } {
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);

  const periods: Scope[] = [
    { key: "p14", label: "Last 14 days", from: addDays(today, -13), to: tomorrow },
    {
      key: "pmonth",
      label: "This month",
      from: new Date(today.getFullYear(), today.getMonth(), 1),
      to: tomorrow,
    },
    {
      key: "plast",
      label: "Last month",
      from: new Date(today.getFullYear(), today.getMonth() - 1, 1),
      to: new Date(today.getFullYear(), today.getMonth(), 1),
    },
  ];

  // Individual days, one week back - the operational view.
  const days: Scope[] = Array.from({ length: 7 }, (_, i) => {
    const from = addDays(today, -i);
    const label =
      i === 0
        ? "Today"
        : i === 1
          ? "Yesterday"
          : from.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
    return { key: `d${dayKey(from.toISOString())}`, label, from, to: addDays(from, 1) };
  });

  // Whole months further back, but only ones that actually hold work, so the
  // list cannot grow past what the workshop has really done.
  const monthKeys = new Set<string>();
  const earlier: Scope[] = [];
  const firstOfLastMonth = periods[2]!.from;
  for (const job of state.history) {
    const when = stamp(job);
    if (when >= firstOfLastMonth) continue;
    const key = `m${when.getFullYear()}-${when.getMonth()}`;
    if (monthKeys.has(key)) continue;
    monthKeys.add(key);
    earlier.push({
      key,
      label: when.toLocaleDateString([], { month: "long", year: "numeric" }),
      from: new Date(when.getFullYear(), when.getMonth(), 1),
      to: new Date(when.getFullYear(), when.getMonth() + 1, 1),
    });
  }
  earlier.sort((a, b) => b.from.getTime() - a.from.getTime());

  return { periods, days, earlier };
}

function countIn(s: Scope): number {
  return state.history.filter((job) => {
    const t = stamp(job).getTime();
    return t >= s.from.getTime() && t < s.to.getTime();
  }).length;
}

/** History inside the current scope - everything below reads from this. */
function scopedHistory(): JobRecord[] {
  return state.history.filter((job) => {
    const t = stamp(job).getTime();
    return t >= scope.from.getTime() && t < scope.to.getTime();
  });
}

/** Client rollups for the scope. Only finished work, so no "open" column. */
function scopedClients(): ClientRecord[] {
  const byClient = new Map<string, ClientRecord>();
  for (const job of scopedHistory()) {
    const entry = byClient.get(job.client) ?? {
      client: job.client, jobs: 0, completed: 0, failed: 0, openJobs: 0,
      machineMinutes: 0, filamentGrams: 0, cost: 0, partial: false,
      firstJobAt: null, lastJobAt: null,
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
    const when = job.finishedAt ?? job.createdAt;
    if (!entry.lastJobAt || when > entry.lastJobAt) entry.lastJobAt = when;
    byClient.set(job.client, entry);
  }
  return [...byClient.values()].sort((a, b) => b.cost - a.cost || a.client.localeCompare(b.client));
}

function scopedTotals(): RecordsPayload["totals"] {
  const history = scopedHistory();
  const done = history.filter((job) => job.status === "done");
  return {
    jobs: history.length,
    completed: done.length,
    failed: history.filter((job) => job.status === "failed").length,
    machineMinutes: done.reduce((sum, job) => sum + job.machineMinutes, 0),
    filamentGrams: done.reduce((sum, job) => sum + job.filamentGrams, 0),
    cost: done.reduce((sum, job) => sum + job.cost, 0),
    clients: new Set(done.map((job) => job.client).filter(Boolean)).size,
  };
}

function renderDays(): void {
  const nav = must("[data-days]");
  const { periods, days, earlier } = buildScopes();

  const group = (title: string, items: Scope[]) =>
    items.length
      ? `<div class="day-group">${escapeHtml(title)}</div>` +
        items
          .map(
            (s) => `
        <button class="day" data-scope="${s.key}" aria-current="${scope.key === s.key}">
          <span>${escapeHtml(s.label)}</span><span class="day-count">${countIn(s)}</span>
        </button>`,
          )
          .join("")
      : "";

  nav.innerHTML = group("Periods", periods) + group("Days", days) + group("Earlier", earlier);
  // Keep the scope lookup in step with what is on screen.
  scopeIndex = new Map([...periods, ...days, ...earlier].map((s) => [s.key, s]));
}

let scopeIndex = new Map<string, Scope>();

function renderScopeLabel(): void {
  const el = qs("[data-scope-label]");
  if (el) el.textContent = scope.label;
  for (const link of qsa<HTMLAnchorElement>("[data-scoped-export]")) {
    const view = link.dataset.scopedExport!;
    link.href = `/api/records/export?view=${view}&from=${scope.from.toISOString()}&to=${scope.to.toISOString()}`;
  }
}

function render(): void {
  renderDays();
  renderScopeLabel();
  renderTotals();
  renderPaused();
  renderClients();
  renderHistory();
  renderSettings();
}

const NO_CLIENT = `<span class="dim">(no client recorded)</span>`;
const clientName = (name: string) => (name ? escapeHtml(name) : NO_CLIENT);
const money = (value: number) => formatMoney(value, state.settings.currency);
const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "—";

function renderTotals(): void {
  const t = scopedTotals();
  const costed =
    state.settings.machineRatePerHour > 0 ||
    Object.values(state.settings.filamentPrices).some((price) => price > 0);
  must("[data-totals]").innerHTML = [
    tile("Clients", String(t.clients)),
    tile("Jobs completed", String(t.completed), t.failed ? `${t.failed} failed` : ""),
    tile("Machine time", formatDuration(t.machineMinutes)),
    tile("Filament used", `${Math.round(t.filamentGrams)}g`),
    tile(
      "Recorded cost",
      costed ? money(t.cost) : "—",
      costed ? "" : "set your rates below",
    ),
  ].join("");
}

function tile(label: string, value: string, note = ""): string {
  return `
    <div class="tile">
      <span class="tile-label">${escapeHtml(label)}</span>
      <span class="tile-value">${value}</span>
      ${note ? `<span class="tile-note">${escapeHtml(note)}</span>` : ""}
    </div>`;
}

/**
 * Paused jobs used to disappear entirely: they persist fine, but no lane on
 * the board renders them, so pausing looked like deleting. This is where they
 * live now, and the only place they can be put back.
 */
function renderPaused(): void {
  const panel = must("[data-paused-panel]");
  panel.hidden = state.paused.length === 0;
  must("[data-paused-count]").textContent = String(state.paused.length);
  if (state.paused.length === 0) return;

  must("[data-paused]").innerHTML = state.paused
    .map(
      (job) => `
        <div class="paused-row">
          <span class="paused-title">${escapeHtml(job.title)}</span>
          <span class="dim">${clientName(job.client)}</span>
          <span class="mono dim">${escapeHtml(formatDuration(job.machineMinutes))}</span>
          <span class="spacer"></span>
          <button data-resume="${job.id}">↩ Back to queue</button>
          <button data-finish="${job.id}">✓ Finished</button>
        </div>`,
    )
    .join("");
}

function renderClients(): void {
  const body = must("[data-clients]");
  const clients = scopedClients();
  if (clients.length === 0) {
    body.innerHTML = `<div class="empty">Nothing finished in ${escapeHtml(scope.label.toLowerCase())}.</div>`;
    return;
  }

  body.innerHTML = `
    <table class="records">
      <thead>
        <tr>
          <th>Client</th><th class="num">Jobs</th><th class="num">Done</th>
          <th class="num">Machine time</th>
          <th class="num">Filament</th><th class="num">Cost</th><th>Last job</th>
        </tr>
      </thead>
      <tbody>
        ${clients
          .map(
            (c) => `
          <tr>
            <td>${clientName(c.client)}</td>
            <td class="num mono">${c.jobs}</td>
            <td class="num mono">${c.completed}${c.failed ? `<span class="fail"> +${c.failed}✕</span>` : ""}</td>
            <td class="num mono">${escapeHtml(formatDuration(c.machineMinutes))}</td>
            <td class="num mono">${Math.round(c.filamentGrams)}g</td>
            <td class="num mono">${escapeHtml(money(c.cost))}${
              c.partial
                ? `<span class="partial" title="Understated: some jobs had no file, or used a filament type with no price set">*</span>`
                : ""
            }</td>
            <td>${escapeHtml(date(c.lastJobAt))}</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>
    ${
      clients.some((c) => c.partial)
        ? `<p class="footnote">* understated — those jobs were either added by hand (no filament recorded) or used a material with no price set below.</p>`
        : ""
    }`;
}

function renderHistory(): void {
  const body = must("[data-history]");
  const history = scopedHistory();
  if (history.length === 0) {
    body.innerHTML = `<div class="empty">Nothing finished in ${escapeHtml(
      scope.label.toLowerCase(),
    )}. Jobs marked done, failed or cancelled land here.</div>`;
    return;
  }

  body.innerHTML = `
    <table class="records">
      <thead>
        <tr>
          <th>Finished</th><th>Client</th><th>Job</th><th>Status</th>
          <th class="num">Time</th><th class="num">Filament</th>
          <th class="num">Cost</th><th>Deadline</th>
        </tr>
      </thead>
      <tbody>
        ${history
          .map(
            (j) => `
          <tr>
            <td>${escapeHtml(date(j.finishedAt))}</td>
            <td>${clientName(j.client)}</td>
            <td title="${escapeHtml(j.title)}">${escapeHtml(j.title)}</td>
            <td><span class="status status-${escapeHtml(j.status)}">${escapeHtml(j.status)}</span></td>
            <td class="num mono">${escapeHtml(formatDuration(j.machineMinutes))}</td>
            <td class="num mono">${j.filamentKnown ? `${Math.round(j.filamentGrams)}g` : "—"}</td>
            <td class="num mono">${escapeHtml(money(j.cost))}</td>
            <td>${
              j.metDeadline === null
                ? `<span class="dim">—</span>`
                : j.metDeadline
                  ? `<span class="met">on time</span>`
                  : `<span class="late">late</span>`
            }</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

function renderSettings(): void {
  const form = must<HTMLFormElement>("[data-settings-form]");
  qs<HTMLInputElement>('[name="currency"]', form)!.value = state.settings.currency;
  qs<HTMLInputElement>('[name="machineRatePerHour"]', form)!.value = String(
    state.settings.machineRatePerHour,
  );

  // Only materials the workshop has actually printed get a price field. A
  // fixed list of every filament on the market would be noise, and a single
  // universal rate was wrong the moment a second material appeared.
  const container = must("[data-filament-prices]");
  container.innerHTML = state.filamentTypes.length
    ? state.filamentTypes
        .map(
          (type) => `
            <div class="field">
              <label for="fp-${escapeHtml(type)}">${escapeHtml(type)} per kg</label>
              <input id="fp-${escapeHtml(type)}" data-filament-price="${escapeHtml(type)}"
                     type="number" min="0" step="0.01"
                     value="${state.settings.filamentPrices[type] ?? 0}" />
            </div>`,
        )
        .join("")
    : `<p class="footnote">No filament types recorded yet — upload a .3mf and the materials it
       uses will appear here to be priced.</p>`;
}

function wire(): void {
  must<HTMLFormElement>("[data-settings-form]").addEventListener("submit", (event) => {
    event.preventDefault();
    void saveSettings(event.currentTarget as HTMLFormElement);
  });

  document.addEventListener("click", (event) => {
    const pick = closest(event.target, "[data-scope]");
    if (pick) {
      const next = scopeIndex.get(pick.dataset.scope!);
      if (next) {
        scope = next;
        render();
      }
      return;
    }

    const resume = closest(event.target, "[data-resume]");
    if (resume) void moveJob(resume.dataset.resume!, "queued", "back in the queue");
    const finish = closest(event.target, "[data-finish]");
    if (finish) void moveJob(finish.dataset.finish!, "done", "marked finished");
  });
}

async function saveSettings(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  try {
    const next = await api<CostSettings>("/api/records/settings", {
      method: "PUT",
      body: JSON.stringify({
        currency: String(data.get("currency") ?? "").trim(),
        machineRatePerHour: Number(data.get("machineRatePerHour") ?? 0),
        filamentPrices: Object.fromEntries(
          qsa<HTMLInputElement>("[data-filament-price]", form).map((input) => [
            input.dataset.filamentPrice!,
            Number(input.value || 0),
          ]),
        ),
      }),
    });
    state.settings = next;
    // Costs are derived, so re-fetch rather than recompute them here.
    state = await api<RecordsPayload>("/api/records");
    render();
    toast("Rates saved.");
  } catch (error) {
    toast((error as Error).message, "error");
  }
}

async function moveJob(jobId: string, status: string, what: string): Promise<void> {
  try {
    await api("/api/jobs/move", {
      method: "POST",
      body: JSON.stringify({ jobId, status, order: [] }),
    });
    state = await api<RecordsPayload>("/api/records");
    render();
    toast(`Job ${what}.`);
  } catch (error) {
    toast((error as Error).message, "error");
  }
}
