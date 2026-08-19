# Printflow

**Work management for a small 3D-printing workshop.** Drop a `.3mf` on it and
the slicer's own print-time estimate becomes a scheduled job with a real
deadline, a client, and a cost.

Bambu Farm Manager already handles machines — monitoring, batch control,
queueing — for free. What it has no concept of is **customers, orders, due
dates or money**. That is the gap Printflow fills: it is the only one of these
tools that knows a job is *due*, and therefore the only one that can tell you
whether the order you have chosen will break a promise.

<!-- IMAGE: the board at ~1600px wide, with a few jobs in the inbox, three or
     four in the queue showing pressure chips, and one printing with the
     countdown mid-run. This is the hero shot — it should be readable at a
     glance and is the single most self-explanatory image in the repo. -->
![The board](docs/images/board.png)

---

## What it does

**Get work in**
- Drop a `.3mf` — print time, filament type and weight, plate previews and the
  printer model it was sliced for are read straight out of the file
- One job per plate, so a four-plate project becomes four schedulable jobs
- Add jobs by hand when there is no file yet
- Client, deadline and notes are captured at intake — the `.3mf` carries none
  of them

**Order it**
- Drag-and-drop board: inbox → queue → printing
- Every queued job shows how much slack it has left, as an instruction
- Live countdown on the running print
- Projected start and finish for everything behind it

**Know what it cost**
- Per-client history: jobs, machine time, filament, spend
- Filament priced per material type
- Excel exports, including a two-sheet report for the previous month

---

## The idea

A spreadsheet with a due-date column is a genuinely good baseline, and it beats
most software. It tells you *that* a job is due Thursday.

What it cannot tell you is that Thursday **stops being possible** once one more
job goes in front of it.

That is the whole product. Printflow knows how long each job takes, in what
order they will run, and when each one is due — so it can answer two questions
nothing else on a workshop bench answers:

**"Where does this have to go?"** Every queued job with a deadline shows its
remaining headroom as an instruction, not a warning:

| Chip | Meaning |
| --- | --- |
| `move up 2` | misses its deadline here; moving it up 2 places fixes it |
| `45m spare` | only 45 minutes of extra work fits ahead of it before it slips |
| `2d 5h spare` | comfortable |
| `can't make it` | misses even as the very next print — the date needs re-agreeing |

**"What can I promise?"** At intake, before a date is agreed with a customer:
*"if you queue this now, ready 08:54 tomorrow — 23:24 today if it jumps the
queue."* Computed from the work already committed to the machine.

Deadline colours are keyed on **slack**, not the clock — time until the
deadline *minus* how long the print takes. A four-hour job due tomorrow at
21:00 turns orange at 17:00 today, not at 21:00.

<!-- IMAGE: a simple left-to-right diagram, ~1200px wide:
     .3mf  →  parsed metadata (time · filament · model)  →  job (+ client, deadline)
           →  projected schedule (start · finish · slack)
     Hand-drawn or Excalidraw is fine; it explains the core idea faster than prose. -->
![How a file becomes a scheduled job](docs/images/pipeline.png)

---

## Screens

**Intake** — drop a file, review what came out of it, create jobs.

<!-- IMAGE: intake at ~1400px, with a .3mf expanded showing plate thumbnails,
     print times, filament chips, and the "ready by" promise line filled in. -->
![Intake](docs/images/intake.png)

**Records** — book-keeping, always scoped to a period.

<!-- IMAGE: records at ~1400px, period sidebar visible on the left with a day
     selected, client rollup and job history populated, costs showing. -->
![Records](docs/images/records.png)

---

## Stack

| Piece | What it does |
| --- | --- |
| **Astro 7** | Pages, SSR, and the client bundle. No UI framework — the board is vanilla TypeScript. |
| **Hono 4** | The JSON API, mounted ahead of Astro's router in `apps/web/src/fetch.ts`. |
| **Cloudflare D1** | SQLite at the edge, via Drizzle 1.0-rc. Holds everything, plate previews included. |
| **Wrangler** | Local runtime (workerd through `@cloudflare/vite-plugin`) and deploys. |

No runtime dependencies beyond those. The `.3mf` parser, the ZIP reader and
writer, and the `.xlsx` writer are all hand-rolled on web standards, so they run
unchanged in a Worker and in a browser.

---

## Project structure

```
apps/web/                     the Astro app — pages, client scripts, and the API
  src/
    fetch.ts                  entrypoint: API routes mount before Astro's router
    layouts/Shell.astro       page chrome and navigation
    pages/
      index.astro             Board — operate the queue
      intake.astro            Intake — get work in, register printers
      records.astro           Records — book-keeping
    scripts/                  client-side controllers (vanilla TS, no framework)
      board.ts                lanes, drag-and-drop, countdown, edit dialog
      intake.ts               upload, plate selection, promise dates, printers
      records.ts              period scoping, client rollups, rates
      cards.ts                the one job-card builder, shared by every lane
      dom.ts                  typed DOM lookups — see INTERNALS for why
      api.ts                  fetch wrapper and toasts
    server/
      context.ts              D1 binding via cloudflare:workers
      queries.ts              board and records loaders (fan-out, not joins)
      records.ts              book-keeping aggregation and report building
      routes/                 jobs · files · printers · records
      schemas.ts              zod request validation
    styles/app.css            design tokens and shared components
  wrangler.jsonc              bindings and migrations directory

packages/db/                  schema, migrations, D1 client
  src/schema.ts               the whole data model, with design notes
  migrations/                 drizzle-kit output (source of truth)
  migrations-d1/              flat mirror that wrangler can apply
  scripts/sync-d1-migrations.mjs

packages/shared/              runtime-agnostic domain logic
  src/threemf.ts              .3mf metadata parser
  src/zip.ts                  dependency-free ZIP reader
  src/zip-write.ts            dependency-free ZIP writer
  src/xlsx.ts                 minimal SpreadsheetML writer
  src/queue.ts                scheduling, deadline pressure, costing
  src/printers.ts             Bambu model catalogue and compatibility
  src/types.ts                domain types

docs/INTERNALS.md             how the interesting parts work
CLAUDE.md                     build plan, positioning, and rejected approaches
```

---

## Running it locally

```bash
pnpm install
```

```bash
pnpm --filter @bambu-organize/web db:apply:local
```

```bash
pnpm --filter @bambu-organize/web dev
```

Then open <http://localhost:4321>.

Local D1 lives under `apps/web/.wrangler/` — delete that directory to start
from an empty database. Note that miniflare keys local state by `database_id`,
so changing that id in `wrangler.jsonc` also gives you a fresh local database.

> **Do not run `astro build` or `astro check` while the dev server is running.**
> They share `node_modules/.vite`, and a build rewrites the dependency cache
> underneath the live server, which then 500s on every request. Stop it first:
> `astro dev stop && rm -rf node_modules/.vite`.

### Changing the schema

```bash
pnpm --filter @bambu-organize/db generate
```

`drizzle-kit` writes `packages/db/migrations/<stamp>/migration.sql`; the same
command mirrors it into `packages/db/migrations-d1/` as the flat files
`wrangler d1 migrations apply` expects. Apply it with `db:apply:local` above.

---

## Deploying

Create the database:

```bash
npx wrangler d1 create bambu_organize
```

Put the returned id on the **`DB`** binding in `apps/web/wrangler.jsonc`.

> `wrangler d1 create` **appends a new binding** rather than filling in the
> existing one. The app reads `env.DB`, so a stray second binding means it will
> talk to a database that was never migrated — and the failure looks like an
> empty app rather than an error.

Apply the migrations to the remote database, then build and ship:

```bash
pnpm --filter @bambu-organize/web db:apply:remote
```

```bash
pnpm --filter @bambu-organize/web build && npx wrangler deploy
```

### Before you share the URL

**The app has no authentication.** Anyone with the link can add, edit and
delete jobs. The intended gate is
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
in front of the hostname — free for up to 50 users, with one-time-PIN login, so
there are no passwords, no user tables and no auth code in this repo.

Access attaches to a hostname in your Cloudflare account, so this needs a custom
domain rather than a bare `*.workers.dev` URL.

### Deploying to someone else's account

Scope wrangler with their credentials rather than logging in as yourself:

```bash
export CLOUDFLARE_API_TOKEN=<theirs> && export CLOUDFLARE_ACCOUNT_ID=<theirs>
```

Then run the same commands. Do not run `wrangler login` while those are set —
it would silently target your own account instead.

---

## First-run configuration

1. **Register a printer** on the Intake page. The model matters: its code is how
   a dropped `.3mf` is matched to the hardware it was sliced for, and a mismatch
   is flagged on the card.
2. **Set your rates** on Records — a machine rate per hour, and a price per
   kilogram for each filament type. Only materials that appear in real jobs are
   listed. Leave them at zero to skip costing entirely.

---

## Status

Working and in use. Not done:

- **Printer telemetry.** `printers.ip_address` / `access_code` and the whole
  `printer_status` table exist for it, and the "now printing" card already
  prefers live data when rows exist — nothing writes them yet, so progress is
  currently projected from start time plus the slicer's estimate. Reading the
  printer would make the schedule honest; controlling it is not the goal.
- **Authentication.** None in the app, deliberately — see above.
- **Touch dragging.** HTML5 drag-and-drop only.
- **Exported times are UTC**, not workshop-local — see
  [Known sharp edges](docs/INTERNALS.md#known-sharp-edges).

---

## How it works

The parts worth explaining — the `.3mf` parser, the spreadsheet writer, the
scheduling algorithms, and the platform constraints that shaped the schema —
are documented in **[docs/INTERNALS.md](docs/INTERNALS.md)**.

`CLAUDE.md` is the build plan: phases, positioning, and a list of approaches
that were tried and rejected, with reasons.

---

## Licence

MIT — see [LICENSE](LICENSE).
