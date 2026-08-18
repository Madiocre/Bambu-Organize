import { Hono } from "hono";
import { z } from "zod";
import { loadAllJobs } from "../queries.js";
import {
  buildMonthlyReport,
  buildRecords,
  buildRecordsWorkbook,
  lastMonthRange,
  loadSettings,
  saveSettings,
  scopeToPeriod,
} from "../records.js";
import { parseBody } from "../http.js";

export const recordsRouter = new Hono();

const settingsSchema = z.object({
  currency: z.string().trim().max(8),
  machineRatePerHour: z.number().min(0).max(1_000_000),
  /** Keyed by filament type; only types the workshop has printed are offered */
  filamentPrices: z.record(z.string(), z.number().min(0).max(1_000_000)).default({}),
});

recordsRouter.get("/", async (c) => {
  const [jobs, settings] = await Promise.all([loadAllJobs(), loadSettings()]);
  return c.json(buildRecords(jobs, settings));
});

recordsRouter.put("/settings", async (c) => {
  const parsed = await parseBody(c, settingsSchema);
  if (!parsed.ok) return parsed.response;
  return c.json(await saveSettings(parsed.data));
});

recordsRouter.get("/export", async (c) => {
  const [jobs, settings] = await Promise.all([loadAllJobs(), loadSettings()]);
  const all = buildRecords(jobs, settings);

  // `?period=last-month` is the accounting export: both sheets, one file,
  // scoped to the previous calendar month.
  if (c.req.query("period") === "last-month") {
    const { from, to, label } = lastMonthRange();
    const report = buildMonthlyReport(scopeToPeriod(all, from, to), label);
    return xlsxResponse(report);
  }

  // Otherwise the export follows whatever window the page is showing, so what
  // downloads is what was on screen.
  const view = c.req.query("view") === "history" ? "history" : "clients";
  const fromParam = c.req.query("from");
  const toParam = c.req.query("to");
  const scoped =
    fromParam && toParam && !Number.isNaN(Date.parse(fromParam)) && !Number.isNaN(Date.parse(toParam))
      ? scopeToPeriod(all, new Date(fromParam), new Date(toParam))
      : all;

  const result = buildRecordsWorkbook(scoped, view);

  return xlsxResponse(result);
});

function xlsxResponse(result: { bytes: Uint8Array<ArrayBuffer>; filename: string }): Response {
  return new Response(result.bytes, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
