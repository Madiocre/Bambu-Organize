# Internals

How the interesting parts of Printflow work. This is not a tour of the
codebase — it covers the pieces whose *reasoning* is not obvious from reading
them: the file-format parsers, the scheduling algorithms, and the places where
a platform constraint dictated the design.

Each section names the file and function so you can jump to the source.

**Contents**

- [Reading a `.3mf`](#reading-a-3mf)
- [Writing spreadsheets](#writing-spreadsheets)
- [Scheduling](#scheduling)
- [Costing](#costing)
- [Platform notes](#platform-notes)
- [Data access and the API](#data-access-and-the-api)
- [Drag and drop](#drag-and-drop)
- [Known sharp edges](#known-sharp-edges)

---

## Reading a `.3mf`

`packages/shared/src/threemf.ts` · `packages/shared/src/zip.ts`

A `.3mf` is an [OPC](https://en.wikipedia.org/wiki/Open_Packaging_Conventions)
package — a plain ZIP. Bambu Studio lays it out roughly like this:

```
3D/3dmodel.model                  the geometry (never read)
Metadata/slice_info.config        XML: per-plate print time, weight, filaments   ← the one that matters
Metadata/model_settings.config    XML: plate names, thumbnail paths
Metadata/project_settings.config  JSON: the full slicing profile
Metadata/plate_1.png              plate preview
Metadata/plate_1.gcode            only in a *sliced* export
```

### Why `prediction` is the load-bearing field

Everything the app does with time comes from one number: `prediction`, in
seconds, inside each `<plate>` block of `slice_info.config`.

It matters because of *when* it is written. The slicer computes it at slice
time, so it is the same figure Bambu Studio shows you and the same one the
printer counts down from. It is not our estimate of the print — it is the
printer's, extracted before the print starts. That is what makes a projected
schedule trustworthy enough to promise a date on.

The server reads it directly off the plate row rather than trusting the client
(`apps/web/src/server/routes/jobs.ts`, `POST /api/jobs`), which is what keeps
*"duration came from the file"* an honest claim on a card. Edit the duration by
hand and the job's `estimateSource` silently flips to `manual`.

### Why parsing XML with regexes is defensible here

These config files are machine-generated, attribute-only XML: no namespaces, no
comments, no CDATA, no nested text content. A regex pass over
`<metadata key="…" value="…"/>` is a complete reader for that shape, and it
saves shipping an XML parser into a Worker that has no DOMParser.

This is a bet with a stated expiry. From the file header:

> If Bambu ever starts nesting real content in these, this is the file to
> rewrite.

### Three dialects in one archive

The same concept is named differently depending on which file you are in, so
the parser joins them by plate index:

| Concept | `slice_info.config` | `model_settings.config` |
| --- | --- | --- |
| Plate number | `index` | `plater_id` |
| Plate name | — | `plater_name` |
| Preview image | — | `thumbnail_file` |

`project_settings.config` is JSON rather than XML, and Bambu writes nearly
everything in it as strings — per-extruder values arrive as arrays of strings,
so `nozzle_diameter` may be `["0.4"]` rather than `0.4`. `parseProjectSettings`
reads defensively rather than trusting the types.

### Traps worth knowing

- **`&amp;` is decoded last.** Decode it first and `&amp;lt;` becomes `<`.
- **Colours may carry an alpha byte** — `#RRGGBBAA`. `normaliseColor` accepts
  6–8 hex characters and truncates to 6 so the value is CSS-usable.
- **UTF-8 BOM** appears on some Windows exports and is stripped on read.
- **Thumbnails are resolved in preference order**: whatever `model_settings`
  points at, then `plate_N.png`, then `plate_N_small.png` — and each candidate
  is checked for actual existence in the archive before use.
- **An unsliced `.3mf` is rejected at upload.** See below — this is the single
  most common real-world failure.

### Unsliced files, and why they are rejected

The most common real failure: a `.3mf` downloaded from a model site, or saved
from Bambu Studio without pressing Slice, **has plates but no print times**.

Two archive states mean this, and both produce the same user-facing message:

- `Metadata/slice_info.config` is absent entirely, or
- it is present but contains **only a header with no `<plate>` blocks** — which
  is what Bambu Studio 02.07.x writes. Observed across four real downloads: a
  205-byte file, versus ~1 KB of plate data in a sliced one.

The confusing part is that the *website* shows plates. Those come from
`model_settings.config`, which describes an **arrangement** — which objects sit
on which plate, with names and preview images. That is a different thing from a
slice *result*. A file can have eight arranged plates and zero print times, and
several of the tested downloads did.

There is no fallback available: every entry of those archives was searched and
no print time exists anywhere. The `print_time` matches inside
`project_settings.config` are slicer *settings* (`fan_cooling_layer_time`,
`machine_load_filament_time`), not an estimate.

So `POST /api/files` rejects with `400` before writing anything, keeping
zero-plate records out of the library. `parseThreeMf` exposes
`hasSliceResults` so callers test a boolean rather than string-matching a
warning, and `POST /api/files/inspect` stays permissive — it persists nothing,
so it still returns the metadata and the warning for previewing a drop.

A **partially** sliced project still works: if plate 1 is sliced and plate 2 is
not, `slice_info` carries one plate block, and one usable plate is the correct
result.

### The ZIP reader

Hand-rolled, because only a handful of small text entries are needed out of a
file that is mostly mesh data and PNGs. Reading the central directory and
inflating on demand is cheaper than a zip library and adds no dependency.

Inflate uses `DecompressionStream("deflate-raw")`, chosen deliberately: it
exists in workerd *and* in every browser we target, so the module runs
unchanged on the server and in the client.

Two details that bite anyone writing a ZIP reader:

- **The end-of-central-directory record has to be found by scanning
  backwards.** It sits behind a comment field of up to 64 KiB, so there is no
  fixed offset — the reader scans from `length - 22` down looking for the
  signature.
- **The local file header repeats the name and extra-field lengths, and they
  can differ from the central directory's.** File data always begins after the
  *local* copies. Using the central directory's lengths here is a classic
  source of silently corrupt reads.

Deliberately unsupported: encryption, and ZIP64 archives whose entry counts or
offsets exceed the 32-bit fields. Bambu Studio produces neither. Both are
detected and throw, and the upload route turns that into a `400` with a
readable message.

---

## Writing spreadsheets

`packages/shared/src/zip-write.ts` · `packages/shared/src/xlsx.ts`

`.xlsx` is the same OPC container as `.3mf`. So the codebase reads one ZIP
format and writes another, with no dependency either way.

Exports are workbooks rather than CSV for one reason: **a date stays a date and
a number stays sortable**, instead of Excel guessing from text and getting it
wrong.

### The ZIP writer

Entries are written **stored** (method 0), never deflated. A jobs export is a
few kilobytes of XML, Excel reads stored entries perfectly well, and it keeps
the writer to arithmetic rather than pulling in a compressor. The upgrade path
is named in the source: switch to `CompressionStream("deflate-raw")`, set
method 8, and record the compressed size.

Two pieces of ZIP trivia the writer has to get exactly right:

- **CRC32** — the standard reflected polynomial `0xEDB88320`, precomputed into
  a 256-entry table. The final `>>> 0` matters: JavaScript bitwise operators
  produce signed 32-bit integers, and the header field is unsigned.
- **MS-DOS packed date/time** — a 1980s format still embedded in every ZIP:

  ```
  time:  seconds/2 → bits 0-4     (2-second resolution)
         minutes   → bits 5-10
         hours     → bits 11-15
  date:  day       → bits 0-4
         month+1   → bits 5-8
         year-1980 → bits 9-15
  ```

The total output size is computed before anything is written
(`Σ(30 + name + data) + Σ(46 + name) + 22`), so the buffer is allocated once
and every field is written by absolute offset — no resizing, no concatenation.

### The SpreadsheetML writer

Enough of the format for a flat table with a bold header, real numbers and real
dates. The parts that are not guessable:

- **Excel's date serial is days since 1899-12-30**, and the `+25569` constant
  converts from the Unix epoch. The odd base date already absorbs the
  Lotus 1-2-3 leap-year bug that Excel preserves for compatibility.
- **Control characters must be stripped.** They are illegal in XML 1.0 and
  Excel rejects the entire file rather than the cell — so one pasted job title
  can break a whole export. Tab, newline and carriage return are deliberately
  preserved.
- **`xml:space="preserve"`** on every inline string, or Excel trims leading and
  trailing whitespace.
- **Strings are inline, not in a shared-strings table.** Slightly larger on
  disk, much smaller in code, and irrelevant at the size of a print queue.
- **Column names are bijective base-26** — `1→A, 26→Z, 27→AA`. Not ordinary
  base-26: there is no zero digit, hence the `(n-1)` arithmetic.
- **Sheet names are sanitised** — Excel rejects names over 31 characters or
  containing `[ ] : * ? / \`.
- **Multi-sheet relationship ids**: worksheets take `rId1…rIdN` and **styles
  takes `rId(N+1)`**. Add a sheet without bumping that and the workbook fails
  to open. `[Content_Types].xml` needs a matching `<Override>` per sheet too.

An empty, default-styled cell emits nothing at all — sparse rows are legal.

---

## Scheduling

`packages/shared/src/queue.ts`

This is the part of the app that a spreadsheet with a due-date column cannot
replace.

### `queueAnchor` — when does the printer free up

Everything downstream is measured from one instant. It is resolved by falling
back through three sources, best first:

1. **Live telemetry** — `printer_status.remainingMin`, once the MQTT bridge
   exists.
2. **The running job's own estimate**, counted from when it started — clamped
   to *now*, so a print that has overrun does not project the whole queue into
   the past.
3. **Now**, if the machine is idle.

### `computeQueueTimeline` — projected start and end

A prefix sum over queued jobs in `position` order, starting at the anchor. The
running job is not a slot; it exists in the projection only as the offset it
pushes everything else by.

Nothing here is persisted. It is recomputed on every render, which is what
keeps it correct as the printer runs ahead of or behind its estimate.

### `deadlineUrgency` — slack, not clock

The colour of a card is not keyed on time-until-deadline. It is keyed on
**slack**:

```
slack = (deadline − now) − jobDuration
```

The difference matters. A four-hour print due tomorrow at 21:00 stops being
comfortable at **17:00 today**, not at 21:00 today — you need the window *plus*
the machine time. Every band is therefore `threshold + how long the job takes`.

| Band | Slack | Colour |
| --- | --- | --- |
| `overdue` | past, **or** not enough time left to print at all | red |
| `imminent` | ≤ 24 h | orange |
| `soon` | ≤ 72 h | yellow |
| `safe` | ≤ 168 h | green |
| `longterm` | > 168 h | grey |
| `none` | no deadline | neutral |

Two deliberate semantic choices:

- **Negative slack reads as `overdue`, not `imminent`.** The deadline has not
  passed, but it is already unreachable — an amber chip on an impossible job
  would be a lie.
- **`none` is not `safe`.** A job with no deadline is not on track; it has no
  target. Colouring it green would claim something untrue.

The thresholds are exported constants and are the single source of truth — the
Excel export calls the same function, so a printed sheet and the screen cannot
disagree.

### `computeDeadlinePressure` — the latest safe slot

The headline algorithm, and the answer to *"a due-date column tells you a job is
due Thursday; it cannot tell you that Thursday stops being possible once one
more job goes in front of it."*

For each queued job carrying a deadline:

```
budget    = deadline − anchor
workAhead = Σ durations of everything currently in front
headroom  = budget − workAhead − ownDuration
```

`headroom` is *"how much additional work could be inserted ahead of this before
it slips"*, in minutes. When it goes negative the job is breached, and the
algorithm finds how far it must move by walking the queue **with the job lifted
out** and accumulating durations until the job no longer fits:

```js
for (let slot = 0; slot <= others.length; slot++) {
  if (ahead + own <= budgetMin) latestSafePosition = slot;
  else break;
  ahead += others[slot] ?? 0;
}
```

**Why the early `break` is sound:** durations are strictly positive, so `ahead`
increases monotonically. Once a slot fails, every later slot fails too. What
looks like it should be a full scan is a prefix scan.

The UI turns each outcome into an instruction rather than a status —
*"move up 2"*, *"can't make it"*, *"4h 30m spare"* — because telling someone
they have a problem is less useful than telling them what fixes it.

> **A design reversal worth recording.** An earlier version measured headroom in
> *queue positions* rather than minutes. That silently conflated two different
> situations: a job genuinely out of time, and a job that merely happened to be
> last in a short queue. The second reported zero slack while having two days to
> spare, and fired constantly. Positions are an artefact of how many jobs
> happen to be queued; minutes are the real constraint.

### `promiseFinish` — the date you can quote

Returns two instants, because the client-facing question has two answers:

- `ifQueued` — accept it now, disrupt nothing. **This is the one to quote.**
- `ifRushed` — what it becomes if it jumps the entire queue.

Quoting the first is what stops the queue being over-committed. The intake page
only shows the rushed figure when jumping the queue actually saves meaningful
time.

---

## Costing

`packages/shared/src/queue.ts` (`jobCost`) · `apps/web/src/server/records.ts`

Filament is priced **per material type**, read from each plate's per-filament
grams — never from the plate's total weight. A single price per kilogram only
made sense for a workshop running one material, and the slicer already records
type and grams for every filament on the plate.

### The buffer asymmetry

This is the one thing in the costing model that will trip a reader, so it is
worth stating plainly:

| | Includes `bufferMin`? |
| --- | --- |
| `jobTotalMin` — scheduling | **yes** |
| `jobCost` — billing | **no** |

The changeover buffer occupies the machine, so the schedule must account for
it. It is not something a customer pays for, so the cost must not. Both are
intentional; they simply answer different questions.

### Honesty over silent zeros

Two mechanisms exist so a total can say how much of itself it is unsure about:

- **`filamentKnown: false`** — the job has no plate (added by hand), so filament
  is *unknown* rather than zero.
- **`unpricedTypes[]`** — a material was printed that has no price set. The
  cost understates, and the client row is marked with a `*` explaining why.

Only work marked `done` counts toward spend. A queued job has not cost anything
yet, and counting it would turn the ledger into a forecast.

### Clients are a `GROUP BY`, not a table

Client rollups aggregate the free-text `requestedBy` field. There is no clients
table, deliberately — inventing one inside the reporting layer would fork the
source of truth. When clients become real records, this aggregation is what
they replace.

---

## Platform notes

### Hono mounted under Astro

`apps/web/src/fetch.ts`

Astro 7's advanced routing calls this file for every request, so **mounting
order is the routing rule**: anything registered before `app.use(astro())` wins
over page routing. That is where the JSON API lives.

### Why `c.env` is empty

`apps/web/src/server/context.ts`

Astro invokes the fetch handler with a bare `Request` — a single argument. Hono
therefore never receives Cloudflare's `(env, ctx)`, and `c.env` is `undefined`.
Bindings come from the global proxy instead:

```ts
import { env } from "cloudflare:workers";
```

This is the adapter's own supported path in Astro 7; `Astro.locals.runtime.env`
was removed and throws an error pointing here.

> **`cf()` from `@astrojs/cloudflare/hono` does not work in this arrangement.**
> It reads `context.env` and `context.executionCtx`, neither of which exists
> here, and 500s every request. It belongs to a *custom worker entrypoint*,
> where Hono itself is the Worker and workerd hands it `(request, env, ctx)`
> directly — a different setup from this one.

### The `Element` type collision

`apps/web/src/scripts/dom.ts`

This program contains both `lib.dom` and the workerd runtime types generated by
`wrangler types`. Both declare `Element`, so the two declarations **merge** —
and workerd's HTMLRewriter members (`remove(): Element`,
`append(content, options): Element`) contradict the DOM's (`remove(): void`,
`append(...nodes): void`).

The merged type satisfies neither side. That poisons everything built on it —
`HTMLElement`, `ParentNode`, and therefore the constraints on
`querySelector<T>`, `querySelectorAll<T>` and `closest<T>`, which is most DOM
code in the app.

The fix is contained in one small module. Method calls still work fine at
runtime and in the checker; only *assignability between* the merged types
fails. So the helpers take **unconstrained** type parameters and a structural
`Queryable`, never naming a poisoned type, and cast at the boundary:

```ts
export function qs<T = HTMLElement>(selector: string, root: Queryable = document): T | null;
```

`HTMLElement` is fine as a *default* — defaults are not checked against a
constraint — so untyped calls still infer sensibly.

The alternative was hand-writing the `Env` interface to keep the runtime types
out. That was rejected: bindings come from `wrangler types` precisely so they
cannot drift from `wrangler.jsonc`. Containing the fallout in one file is the
cheaper side of the trade.

**All client-side DOM lookups go through this module.** It is not stylistic.

### D1 limits that shaped the schema

Two hard numbers drove real design decisions:

| Limit | Consequence |
| --- | --- |
| **2 MB per row** | Uploaded archives (1.3–4.9 MB in practice) cannot be stored in D1 at all |
| **100 KB per statement** | Thumbnails are inserted one row at a time; plates and filaments are batched |

Plate previews (18–22 KB) live base64-encoded in their own `plate_thumbnails`
table rather than as a column on `file_plates` — the board reads plate rows on
every render, and a blob column would drag tens of kilobytes into a query that
only wants durations. Base64 rather than a blob column because drizzle's
`blob({ mode: "buffer" })` maps to a Node `Buffer`, which does not exist in
workerd. The ~33% overhead is irrelevant at this size.

**The uploaded archive is discarded entirely** after parsing. It was previously
written to R2 and never read back by anything. This is why the thumbnail is
extracted eagerly during upload — afterwards there is nothing left to re-derive
it from.

### Migration mirroring

`packages/db/scripts/sync-d1-migrations.mjs`

Two tools with incompatible layouts. drizzle-kit 1.x writes
`migrations/<stamp>_<name>/migration.sql` plus a snapshot; `wrangler d1
migrations apply` wants a flat directory of `<stamp>_<name>.sql` and nothing
else.

Rather than pick one, drizzle's directory stays the source of truth and the
script mirrors it into `migrations-d1/` — deleting and regenerating, so the
mirror cannot drift. It is chained off the `generate` script.

### Vite and the workspace packages

`packages/shared` and `packages/db` ship TypeScript source with no build step,
so Vite has to transform them rather than externalise them — hence `noExternal`
in `astro.config.mjs`.

---

## Data access and the API

### The routes

| Route | Purpose |
| --- | --- |
| `GET /api/jobs/board` | Everything the board renders, in one payload |
| `POST /api/jobs` | Create a job (manual, or from a plate) |
| `POST /api/jobs/from-file` | One job per plate of an uploaded file |
| `POST /api/jobs/move` | Every drag: lane change and/or reorder |
| `PATCH` / `DELETE /api/jobs/:id` | Edit, remove |
| `GET /api/jobs/:id/events` | A job's history |
| `GET` `POST` `PATCH` `DELETE /api/printers` | Printer registry |
| `GET /api/printers/models` | Bambu machine catalogue (model codes) |
| `POST /api/files` | Upload and parse a `.3mf` |
| `POST /api/files/inspect` | Parse without storing |
| `GET /api/files/:id/plates/:n/thumbnail` | Extracted plate preview |
| `GET /api/records` | Book-keeping payload |
| `PUT /api/records/settings` | Costing rates |
| `GET /api/records/export?view=…&from=&to=` | Clients or history for a window, as xlsx |
| `GET /api/records/export?period=last-month` | Two-sheet report for the previous month |

Validation errors return `{ error }` with a single human-readable sentence,
because the client surfaces that string directly in a toast — so it has to read
like something a person wrote.

### Fan-out instead of a join

`apps/web/src/server/queries.ts`

The board needs each job plus the file, plate, printer and filament rows behind
it. That is a four-way join fanning out to many filament rows — SQL would
return a cartesian product that has to be de-duplicated in JavaScript anyway.

So it issues a handful of `IN` queries and stitches the result with `Map`
lookups. Queues here are tens of rows and every round trip is to the same D1
instance.

### `loadBoard` vs `loadAllJobs`

The board reads only `backlog`, `queued` and `printing`. It used to read every
job ever created, which was correct but made each render cost the entire
history — a query that gets slower forever. Closed and paused work appears only
on Records, which asks for it explicitly.

### The move contract

`apps/web/src/server/routes/jobs.ts` — `POST /api/jobs/move`

Every drag on the board goes through one endpoint, and the contract is
deliberately blunt: **the client sends the destination lane's complete id list
as it should be after the drop**, and the server rewrites that lane's positions
wholesale.

No fractional indexing, no reconstructing intent from a position delta. The
stored order always matches what is on screen, and there is no drift to
accumulate.

Three details:

- **Stale ids are ignored.** The client's list is intersected with an actual
  `SELECT` of jobs currently in that lane, so an id that has since moved
  elsewhere cannot resurrect a stale row.
- **One print per machine.** Moving a second job to `printing` on a printer that
  already has one returns **409** naming the conflicting job. Rejecting is
  better than silently demoting whatever was running.
- **Timestamps are server-derived.** `statusTransitionFields` sets `startedAt`
  on entering `printing` but *preserves an existing one*, so re-dropping a card
  does not reset the countdown. Returning a job to `backlog` or `queued` clears
  both timestamps, so an abandoned run does not leave a misleading history.

### Uploads

`apps/web/src/server/routes/files.ts`

- **Deduplicated by SHA-256** of the whole archive. Re-uploading the same
  export (someone re-downloads it from a chat) returns the existing record and
  its plates rather than duplicating them.
- **64 MB upload ceiling** — Workers cap request bodies at 100 MB and the ZIP
  reader needs the whole archive in memory to walk the central directory.
  Anything larger is almost always the wrong file.
- **1 MB thumbnail ceiling** — a sanity bound against D1's 2 MB row limit.
  If a future slicer embeds something enormous, dropping the preview beats
  failing the whole upload.

---

## Drag and drop

`apps/web/src/scripts/board.ts`

Plain HTML5 drag-and-drop, no library.

### The reversed queue lane

Row 2 reads right-to-left *into* the machine: the queue's rightmost card is the
one that goes on next, sitting directly beside the "now printing" panel. That
is why there is no separate "next up" column — being next is simply being at
the head, marked with a badge.

The lane is `flex-direction: row-reverse`, which means **DOM order still runs
head-first** and only the hit testing has to know about the flip. The entire
reversal is one ternary in `cardAtPoint`:

```js
const before = axis === "horizontal-reversed" ? pointer > midpoint : pointer < midpoint;
```

In a reversed lane, "further along the pointer axis" means *earlier* in the
queue. Getting this comparison backwards silently inverts every drop, which is
why it is deliberately the single place the reversal is allowed to leak.

Everything downstream builds its id list from DOM order and stays oblivious.

### Two clocks

Deliberately separate:

- **Every second** — the countdown on the running job, mutated in place via
  `data-` attributes. A full re-render would restart the thumbnail load and make
  the digits visibly stutter.
- **Every minute** — the full repaint: projected start times, deadline flags,
  pressure chips. Nothing in it changes faster than that.

The tick reads its inputs off the DOM rather than shared state, so it survives a
re-render; if the element is gone, there is nothing to do.

### Optimistic moves

A drop repaints from local state immediately — the card has already moved
visually, so waiting for the server would look broken. `structuredClone` of the
job list is taken first, and restored if the request fails.

The server responds to `/api/jobs/move` with a **complete board payload**, not a
diff, so the correction is total rather than incremental.

---

## Known sharp edges

Documented rather than hidden.

### Exported timestamps are UTC, not workshop-local

**Confirmed by probing workerd**: `new Date().getTimezoneOffset()` returns `0`
and `Intl.DateTimeFormat().resolvedOptions().timeZone` is `UTC`.

The board renders dates in the browser, so it shows workshop-local time. Excel
exports are generated on the Worker, where the timezone shift in `excelSerial`
is a no-op — so they encode UTC wall-clock. For a workshop at UTC+2 that is a
two-hour discrepancy between the same deadline on screen and in the sheet:

| | Shown |
| --- | --- |
| Stored | `2026-08-14T21:00:00Z` |
| Board (browser, UTC+2) | 23:00 |
| Excel (Worker, UTC) | 21:00 |

`lastMonthRange` has the same property: month boundaries land on UTC midnight,
so a job finished just after local midnight on the 1st can fall on the other
side of a monthly report boundary from where the day sidebar puts it.

Fixing this properly needs a workshop timezone setting — the app has no notion
of one today. Until then, treat exported times as UTC.

### `job_events` is written far more than it is read

Every create, move, edit and status change appends a row. It is read in exactly
one place: the history list in the board's edit dialog. At ~140 bytes a row this
is harmless, and it is the right table to already have when an audit trail is
wanted — but it is currently closer to write-only than the write volume
suggests.

### Duplicate serials are detected by string matching

`apps/web/src/server/routes/printers.ts` catches a unique-constraint violation
by testing whether the error message contains `"UNIQUE"`. It works, and it is
stringly-typed.

### `jobs.position` is `real`

A leftover affordance for fractional indexing, which the full-lane-rewrite
strategy makes unnecessary. Integers would do.
