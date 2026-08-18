# Printflow — Bambu queue

Work management for a small 3D-printing workshop. Jobs are added by hand or by
dropping a `.3mf` on the intake page, where the slicer's own print-time
estimate is read straight out of the file, then ordered on a drag-and-drop
board that projects when each one will finish.

The queue is the foundation, not the point. Bambu Farm Manager already handles
machines — monitoring, batch control, queueing — for free. What it has no
concept of is **customers, orders, due dates or money**, and that is the layer
this is growing into: who asked for a print, when it is due, what it cost.
Reading the printers is a supporting feature so the schedule stops lying, not
the destination. See `CLAUDE.md` for the positioning and roadmap.

## Stack

| Piece    | What it does                                                   |
| -------- | -------------------------------------------------------------- |
| Astro 7  | Pages, SSR, and the client bundle. No UI framework — the board is vanilla TS. |
| Hono 4   | The JSON API, mounted ahead of Astro's router in `src/fetch.ts`. |
| D1       | SQLite at the edge, via Drizzle 1.0-rc. Holds everything, previews included. |
| Wrangler | Local runtime (workerd through `@cloudflare/vite-plugin`) and deploys. |

```
apps/web            Astro app: pages, client scripts, and the Hono API
  src/fetch.ts        entrypoint — API routes first, then Astro
  src/server/         routes, queries, validation, bindings
  src/scripts/        client-side board and intake controllers
packages/db         Drizzle schema, migrations, D1 client
packages/shared     domain types, queue maths, printer catalogue, .3mf parser
```

## Running it

```bash
pnpm install
```

```bash
pnpm --filter @bambu-organize/web db:apply:local
```

```bash
pnpm --filter @bambu-organize/web dev
```

Local D1 lives under `apps/web/.wrangler/` — delete that directory to start
from an empty database. Note that miniflare keys local state by `database_id`,
so changing that id in `wrangler.jsonc` also gives you a fresh local database.

### Pages

One page, one role, so there is never a question of where a control belongs:

| Page | Role |
| ---- | ---- |
| `/` | **Board** — operate the queue: order it, start and finish prints. Full-bleed. |
| `/intake` | **Intake** — get work in: upload a `.3mf`, add a job by hand, register the machines. |
| `/records` | **Records** — book-keeping: clients, job history, paused work, filament and cost. |

Jobs marked paused, finished or failed leave the board and appear in Records.
They are never deleted — that lane simply does not exist on the board, which
is what previously made pausing look like deleting.

Records is always **scoped to a period** — there is deliberately no all-time
view, because nobody reads a business's whole history in one scroll and the
page would get slower every month it ran. The sidebar offers:

- **Periods** — Last 14 days, This month, Last month
- **Days** — the last seven, individually
- **Earlier** — whole months, listed only when they actually contain work, so
  the list cannot outgrow what the workshop has done

Picking one scopes the totals, the client rollup, the history *and* the export
buttons together, so what downloads is what was on screen. Days are local
calendar days, not UTC — a print finishing at 01:00 belongs to the day the
workshop lived, not the previous one.

Board cards have an **edit** button (✎) covering title, client, deadline,
duration, copies, changeover, printer, rush and notes. Editing the duration of
a job whose time came from a `.3mf` re-marks the estimate as manual, and the
dialog says so before you do it.

Width comes from `Shell.astro`'s `width` prop (`full` or `readable`); pages
should not set their own `max-width`.

### Types

Binding types are generated, never hand-written: `wrangler types` reads
`wrangler.jsonc` and writes `apps/web/worker-configuration.d.ts`, so `Env`
cannot drift from the bindings actually configured. The `dev`, `build` and
`check` scripts all run it first.

That file also brings the workerd runtime types into the same TypeScript
program as `lib.dom`, and the two `Element` declarations merge into something
that satisfies neither — which breaks the constraints on `querySelector<T>`,
`closest<T>` and friends. All client-side DOM lookups therefore go through
[`src/scripts/dom.ts`](apps/web/src/scripts/dom.ts), which contains the whole
problem in one small module. Use `qs` / `must` / `qsa` / `closest` from there
rather than the raw generic DOM methods.

### Schema changes

```bash
pnpm --filter @bambu-organize/db generate
```

`drizzle-kit` writes `packages/db/migrations/<stamp>/migration.sql`; the same
command mirrors it into `packages/db/migrations-d1/` as the flat files
`wrangler d1 migrations apply` expects. Apply with the `db:apply:local` script
above.

### Deploying

Create the real resources and put the D1 id into `apps/web/wrangler.jsonc`:

```bash
wrangler d1 create bambu_organize
```

Put the returned id on the **`DB`** binding in `wrangler.jsonc` — `wrangler`
appends a *new* binding rather than filling in the existing one, and the app
reads `env.DB`, so a stray second binding means the app talks to a database
that was never migrated.

Then `pnpm --filter @bambu-organize/web build` and `wrangler deploy`. Note that
the app currently has **no authentication** — put it behind Cloudflare Access
or add a login before exposing it beyond a LAN.

## What we read out of a `.3mf`

A `.3mf` is a zip. Bambu Studio writes its slicing results into
`Metadata/slice_info.config`, one `<plate>` block per plate:

| Field                  | Used for                                                        |
| ---------------------- | --------------------------------------------------------------- |
| `prediction` (seconds) | The job's duration. This is the number the printer counts down.  |
| `weight` (grams)       | Filament planning; shown per job and per plate.                  |
| `<filament>` entries   | Type, colour, AMS slot, metres and grams — the swatches on cards.|
| `printer_model_id`     | e.g. `BL-P001`. Matched against registered printers to flag a plate sliced for the wrong machine. |
| `nozzle_diameters`     | Same, for nozzle mismatches.                                     |
| `support_used`, `timelapse_type`, `label_object_enabled` | Badges. |
| `<object>` entries     | Object count and names.                                          |

Alongside it, `Metadata/model_settings.config` gives plate names,
`Metadata/project_settings.config` gives the full slicing profile (layer
height, bed type, filament list), `Metadata/plate_N.png` is the preview shown
on cards, and `Metadata/plate_N.gcode` — present only in a *sliced* export —
is what makes a file directly sendable to a printer later.

Parsing lives in `packages/shared/src/threemf.ts` on top of a small
dependency-free zip reader (`zip.ts`) built on `DecompressionStream`, so it
runs unchanged in workerd and in the browser.

**The uploaded archive is not kept.** It is parsed in memory, the plate preview
is extracted, and the bytes are discarded. Real files run 1.3-4.9 MB, D1 caps
any row at 2 MB, and R2 needs a payment card on the account — but more to the
point, nothing ever read the original back. Only the preview is stored, in
`plate_thumbnails` (base64, 18-22 KB each, roughly 18,000 of them before the
500 MB per-database cap). Re-upload is the recovery path. If printer control
ever needs to send the file, that is the moment to add object storage back.

A project `.3mf` saved before slicing has no `slice_info.config`. That is not
an error: the file record is still created, and the upload returns a warning
telling the user to slice it or enter a duration by hand.

## The board

Row 1 — **Inbox**: everything added but not committed to a machine. Cards carry
a coloured spine keyed on **slack** — time until the deadline *minus* how long
the print takes — so a 4h job due tomorrow at 21:00 turns orange at 17:00
today, not at 21:00:

| Colour | Slack |
| ------ | ----- |
| Red | deadline passed, **or** not enough time left to print it at all |
| Orange | under 24h |
| Yellow | under 3 days |
| Green | under 7 days |
| Grey | more than 7 days |
| Neutral | no deadline — not "safe", just no target |

Thresholds live in `deadlineUrgency()` in `packages/shared/src/queue.ts` and
nowhere else; the Excel export calls the same function.

Row 2 — **Queue** then **Now printing**, reading right-to-left into the
machine. The queue's *rightmost* card is the one that goes on next and carries
a "Next up" badge, so it sits directly beside the printer panel. There is no
separate next-up column: being next is just being at the head.

Row 3 — **Projected schedule**: a placeholder. It renders the timeline the
queue maths already produces, and is meant to be replaced once row 3 has a
defined scope.

### Job titles

Every plate inside a `.3mf` is called "Plate 1", so jobs from different
customers were a wall of identical titles separated only by thumbnail. Titles
generated from a file are composed client-first:

```
Mohamed Esam (Fidget_Karambit)[Plate 1]
```

falling back to `Fidget_Karambit [Plate 1]` with no client, via
`composeJobTitle()` in `packages/shared/src/queue.ts`. Manually-added jobs keep
whatever title was typed. The client name is *denormalised* into the title, so
renaming a client later will not rewrite existing job titles — worth knowing
when the edit-job screen lands.

### What it does that a spreadsheet cannot

A due-date column tells you *that* a job is due Thursday. It cannot tell you
that Thursday stops being possible once one more job goes in front of it. Two
features come out of that, and they are the reason this exists:

**Latest safe slot.** Every queued job with a deadline shows how much room it
has left, as an instruction rather than a warning:

| Chip | Meaning |
| ---- | ------- |
| `move up 2` | misses its deadline here; moving it up 2 places fixes it |
| `45m spare` | only 45m of extra work fits ahead of it before it slips (amber under an hour) |
| `2d 5h spare` | comfortable |
| `can't make it` | misses even as the very next print — the date needs re-agreeing |

Headroom is measured in **time, not queue positions**. Positions are an
artifact of how many jobs happen to be queued: a job sitting last had zero
positions of slack even with two days to spare, which fired constantly and
meant nothing.

The board's summary leads with the count of broken promises, because that is
the only part of it anyone has to act on.

**Promise dates.** On intake, before a date is agreed with a customer:
*"if you queue this now, ready 08:54 tomorrow — 23:24 today if it jumps the
queue"*. It updates live as the duration, copies and plate selection change,
and is computed from the work already committed to the machine.

Both come from `computeDeadlinePressure` and `promiseFinish` in
`packages/shared/src/queue.ts`. Nothing is stored — they are recomputed on
render, so they stay true as the printer runs ahead of or behind estimate.

Dragging is plain HTML5 drag-and-drop. Every drop posts to `POST /api/jobs/move`
with the destination lane's full id list *after* the drop, and the server
rewrites that lane's positions — so the stored order always matches what is on
screen, with no fractional-index drift. Pointer/touch dragging is not wired up
yet.

The queue lane is `flex-direction: row-reverse`, so DOM order stays head-first
and only the drag hit-testing knows about the flip (`cardAtPoint` in
`src/scripts/board.ts`). Getting that comparison wrong silently inverts every
drop, so it is deliberately the single place the reversal leaks.

Scheduling is projected, never stored: `computeQueueTimeline` walks the queue
from an anchor that is the printer's live remaining time when telemetry
exists, the running job's estimate when it doesn't, and "now" when the machine
is idle.

## API

| Route                                       | Purpose                                        |
| ------------------------------------------- | ---------------------------------------------- |
| `GET /api/jobs/board`                       | Everything the board renders, in one payload.  |
| `POST /api/jobs`                            | Create a job (manual, or from a plate).        |
| `POST /api/jobs/from-file`                  | One job per plate of an uploaded file.         |
| `POST /api/jobs/move`                       | Every drag: lane change and/or reorder.        |
| `PATCH`/`DELETE /api/jobs/:id`              | Edit, remove.                                  |
| `GET`/`POST`/`PATCH`/`DELETE /api/printers` | Printer registry.                              |
| `GET /api/printers/models`                  | Bambu machine catalogue (model codes).         |
| `POST /api/files`                           | Upload and parse a `.3mf`.                     |
| `POST /api/files/inspect`                   | Parse without storing.                         |
| `GET /api/files/:id/plates/:n/thumbnail`    | Extracted plate preview.                       |
| `GET /api/jobs/:id/events`                  | A job's history.                               |
| `GET /api/records`                          | Book-keeping payload.                          |
| `PUT /api/records/settings`                 | Costing rates.                                 |
| `GET /api/records/export?view=…&from=&to=`  | Clients or history for a window, as xlsx.      |
| `GET /api/records/export?period=last-month` | Two-sheet report for the previous month.       |

## Excel export

All exports live on **Records** — the board exports were removed, since a
snapshot of the current queue is worth far less than the history behind it.

- **Export period** — clients or history for whatever window is selected.
- **Last month report** — one file, two sheets (clients + jobs), scoped to the
  previous calendar month. This is the accounting export.

Written by `packages/shared/src/xlsx.ts` on top of a small store-only zip
writer (`zip-write.ts`) — the same OPC container a `.3mf` uses, so the codebase
reads one zip format and writes another with no dependencies either way. It is
a workbook rather than a CSV so dates stay dates and numbers stay sortable.

## Costing

Filament is priced **per type**, not with one universal rate — PLA and PETG do
not cost the same, and the slicer already records the type and grams of every
filament on a plate. The rates form lists only materials that appear in real
jobs, so it never shows a catalogue of things the workshop does not own.

Machine time is billed on the print itself, not the changeover buffer: the
buffer is scheduling slack, not something a customer pays for.

Anything printed with a type that has no price set is reported rather than
silently costed at zero — the client row carries a `*` and the footnote says
why. Same for jobs added by hand, which have no filament data at all.

## Query cost

`loadBoard()` reads only `backlog`, `queued` and `printing`. It used to read
every job ever created on every render, which was correct but got slower
forever; closed and paused work is only ever shown on Records, which asks for
it explicitly via `loadAllJobs()`.

Measured on real data: a plate thumbnail is ~27 KB and dominates storage; a job
row is ~181 bytes and an event ~140. At 20 jobs/week that is ~30 MB/year
against D1's 500 MB per-database cap — roughly 17 years — and after a full year
of history, 200 page loads a day is about 4% of the free daily read limit. No
purging is needed; the export exists for accounting, not for cleanup.

## Not done yet

- **Direct printer control.** `printers.ip_address` / `access_code` and the
  whole `printer_status` table exist for it, and the "now printing" card reads
  from that table when it has rows — nothing writes them yet, so progress
  currently comes from elapsed-time-versus-estimate. The bridge (MQTT over TLS
  to the printer on port 8883, or the cloud API) is the next phase.
- **Auth.** None in the app, deliberately. This is a single-tenant tool for one
  workshop, so the plan is Cloudflare Access in front of the hostname (free up
  to 50 users, one-time-PIN login) rather than users/sessions tables — see
  `CLAUDE.md`, phase 2.5. Until that is configured, do not expose the
  deployment beyond a LAN.
- **Touch dragging.** HTML5 DnD only.
- **Row 3.** Awaiting scope.
