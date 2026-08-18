## What this is, and the order it gets built in

Printflow is a queue and job-management system for Bambu Lab printers. It
started as a scraper because the API wasn't reachable; that is no longer the
constraint, so it is being built against real printer data.

Phases, in order. **Do not start work from a later phase while an earlier one
is unfinished** — if a request seems to need it, say so and ask.

| # | Phase | Status |
| - | ----- | ------ |
| 1 | Queue model: schema, `.3mf` metadata ingest, job CRUD, drag-and-drop board | **done** |
| 2 | Finish the queue: UI *and* the client-facing features around it | done enough to move on |
| 2.5 | **Gate the app** — single tenant, no accounts to build | **current** |
| 3 | **Commitment tracking** — latest-safe-slot, promise dates | **done** |
| 3.5 | **Book-keeping** — clients, history, paused jobs, filament, cost | **done** |
| 3.6 | Edit a job after creation, day-scoped records | **done** |
| 4 | Printer telemetry, read-only — make the projected schedule honest | bonus, not the point |
| 5 | Direct printer control (start/pause/stop) | probably never; see positioning |
| 6 | Row 3 of the board | blocked — scope undefined, ask before filling it |

Phase 2 is not UI-only. It covers everything that makes the queue usable as a
job-management tool for real customer work, which includes data the printer
never supplies:

- **Board and intake polish** — layout, density, drag behaviour, empty states.
- **Job metadata the `.3mf` cannot carry.** The format describes the *print*,
  not the job: there is no client name, due date, or instruction anywhere in
  it. `requestedBy`, `deadline` and `notes` are always entered by hand, both
  on the manual form and as a per-batch block when creating jobs from a file.
  Never present these as something the upload could fill in.
- **Deadline urgency** — inbox cards are flagged red / orange / yellow / green
  by `deadlineUrgency()` in `packages/shared/src/queue.ts`. Thresholds live
  there and nowhere else; the Excel export reads the same function so a
  printed sheet and the screen cannot disagree.
- **No all-time view on Records.** It is always a period: 14 days / this month
  / last month, the last seven days individually, and whole months further
  back. An unbounded history list gets slower and less readable every month,
  and aggregate spend "since the business started" is not a number anyone
  acts on. Exports follow the selected period.
- **Filament is priced per type**, in the `filament_prices` table, and the
  rates form only offers materials that appear in real jobs. A single
  universal rate was wrong the moment a second material appeared. Unpriced
  types are surfaced as understated totals, never costed as zero.
- **Export** — all exports are on Records: clients, history, and a two-sheet
  previous-month report, via the dependency-free writer in
  `packages/shared/src/xlsx.ts`. The board's own export buttons were removed;
  a snapshot of the queue is worth less than the history behind it.

Small additions to the schema or API *are* in scope here when a queue feature
needs them (export needed a route; batch metadata needed two schema fields).
What is out of scope is anything that talks to a printer — that is phase 4.

### Phase 2.5 — gating the app

**Decided: single tenant.** One workshop, 2-3 staff, one shared board, no
per-user data. This is not a placeholder for multi-tenancy — build for the
decision that was made.

**Therefore: do not build `users` or `sessions` tables, sign-up, password
reset, or email verification.** All of it is machinery for a problem this
deployment does not have. Nothing in the schema needs an owner column.

#### Use Cloudflare Access, not application auth

The app needs *a locked front door*, not an identity system. Cloudflare Access
gives exactly that, and it is free for up to 50 users:

- It sits in front of the Worker at the hostname, so **there is no auth code in
  this repo at all** — no routes, no tables, no cookies, no libraries.
- **One-time PIN** login mails a code to an approved address, so there is no
  password to hash. That sidesteps the whole 10 ms CPU problem below, and it
  means no Resend account and no email-sending integration.
- Each of the 2-3 staff gets their own login against a shared board. That is
  strictly better than one shared password: no shared secret to leak, access
  revocable per person, and no "who changed the queue" ambiguity.
- If attribution is ever wanted, Access passes the authenticated email through
  to the Worker in a request header, so `requestedBy`-style fields can be
  filled without building accounts.

**Prerequisite:** Access policies attach to a hostname in your Cloudflare
account, so the Worker needs a custom domain rather than a bare `*.workers.dev`
URL. Confirm whether a plain `workers.dev` subdomain can be covered before
relying on it — do not assume it can.

#### Why not passwords (kept for the record)

If application-level auth is ever revisited, this is the constraint that
killed it the first time. Workers Free allows **10 ms CPU per request**.
Measured on this project's own workerd, PBKDF2-HMAC-SHA256 at the OWASP
600,000 iterations costs **~130-220 ms of CPU** — 13-22x over — and PBKDF2 via
WebCrypto is the *fastest* option available; pure-JS scrypt and Argon2id are
far worse. Roughly 45,000 iterations fit in 10 ms, about 7% of the recommended
work factor. Never respond to this by weakening the hash. Passwords require
either a passwordless flow or Workers Paid ($5/mo, CPU limit 30 s).

Related dead ends, so nobody re-discovers them: **MailChannels' free Workers
email API was terminated on 30 June 2024**, and **Cloudflare Email Service**
outbound sending is beta and requires Workers Paid (sending to verified
destination addresses in your own account is free, which is enough for dev).

#### The free tier fits the data comfortably

| Resource | Free-plan ceiling | This workload |
| -------- | ----------------- | ------------- |
| D1 rows read | 5,000,000 / day | a board load is tens of rows |
| D1 rows written | 100,000 / day | fine |
| D1 storage | 5 GB total, 500 MB per database | fine |
| D1 queries per Worker invocation | **50** | `loadBoard` uses ~8; keep an eye on it |
| Workers requests | 100,000 / day | fine |
| Workers CPU | 10 ms / request | fine *as long as nothing hashes passwords* |

Everything lives in D1 — R2 needs a payment card the account does not have.
Plate previews sit in `plate_thumbnails` (~27 KB of base64 each, so roughly
18,000 before the 500 MB per-database cap) and uploaded archives are parsed and
discarded. That stays well inside the free tier for one workshop.

#### If this becomes a SaaS later

That is an explicit future possibility, not the current build. When it comes:

- Every table needs a tenant owner, and every query needs a tenant filter.
- The cheap insurance *now* is not to add unused columns — it is to keep all
  reads funnelled through `src/server/queries.ts` and the route handlers, so
  adding a filter later is a contained change rather than a hunt. Avoid
  querying D1 from new places.
- Revisit the password/CPU note above; SaaS means real accounts, which means
  Workers Paid.
- Re-check the free-tier table: per-day D1 limits that are enormous for one
  workshop are not enormous for many.

### Positioning — what this competes on

This was checked rather than assumed, because it decides what gets built.

**Bambu Connect** is not the competitor — it is the small utility that ships
sliced gcode/3mf to the printer. The competitor is **Bambu Farm Manager**.

**Bambu Farm Manager** (free, first-party, out of beta May 2025) already does
real-time monitoring, batch control, **smart queuing that assigns jobs by
printer availability**, folders/tags/filters for files, and firmware upgrades.
It is Windows-only and local-network only, and covers P1 / A1 / X1C with X1E
and H2D added later.

So: **a print queue plus printer control is a smaller, weaker Farm Manager**,
built against an interface we do not control, for hardware whose vendor ships
the competitor for free. That is not a fight worth picking.

What Farm Manager does *not* have, per Bambu's own announcement, is any notion
of **customers, orders, due dates, or money**. That is not an oversight they
are racing to fix — Bambu sell printers, and shop administration is off their
axis. It is also precisely what this app already started doing: `requestedBy`,
`deadline` with urgency bands, `notes`, and the Excel export.

The gap being aimed at is therefore **the small shop**: 1-3 printers, 2-3
staff. Farm Manager serves the machines but not the business. The SaaS tools
that *do* serve the business (Printago and similar) are built for production
farms with Etsy/Shopify order volume, and are far too heavy here. Under-served
small end, above the machines, below the farms.

Two honesty notes for whoever reads this later:

- Vendor claims conflict. Printago's marketing says Farm Manager has "no
  automated job queue"; Bambu's own announcement says it has smart queuing.
  Both are motivated sources. Verify before repeating either.
- Being web-based is a real structural advantage over a Windows desktop app
  (any device, no install), but it is not a *product* — it is table stakes.
  The differentiator is the managerial data, not the delivery mechanism.

### Who this is for, and the one thing it does

The first workshop: **one printer, a second planned, three staff with separate
roles.** One handles marketing and clients, one does design, one runs the
printer. That split matters more than the printer count — it is the reason a
machine tool does not fit.

Every competitor assumes the user *is* the operator. Farm Manager, SimplyPrint
and Printago are all built around the machine, so the person who talks to
customers has no seat in them at all. Printflow's distinctive user is the
client-facing one: the person who has to promise a date and later answer "is it
ready yet?".

**The thesis, in one sentence:** Printflow is the only one of these tools that
knows a job is *due* on a date, and therefore the only one that can tell you
whether the order you have chosen will miss a commitment.

Everything follows from that:

- Nobody else has deadlines *at all*. Farm Manager assigns by printer
  availability; Printago routes by material and capability; SimplyPrint gates
  its queue behind a paid tier. None of them can answer "can I promise
  Thursday?" because none of them know Thursday exists.
- This is the rare feature that is **as valuable at one printer as at fifty**.
  Fleet routing — the competitors' core value — is worth nothing with one or
  two machines. Commitment tracking is worth the same at any scale, so the
  small end is an advantage here, not a limitation.
- Confirmed with the workshop directly: deadline management was the thing that
  immediately landed. Not monitoring, not control.

#### Deliberately not doing: notifications

The printer already beeps and Bambu Handy already pushes to their phones when a
print finishes. Duplicating that adds noise and competes with a first-party app
that does it better. Machine *events* are a solved problem for this user.

What is **not** solved, and what this app is for, is machine *plans*: is the
queue order still going to meet what was promised.

### Competitive scan — checked, not assumed

Three tools were compared against this one at **free tier**, since that is how
it will be run and distributed.

| | Bambu Farm Manager | SimplyPrint free | Printago free | Printflow |
| --- | --- | --- | --- | --- |
| Cost | free | free | free forever | free, self-hosted |
| Printers | P1/A1/X1C (+X1E, H2D later) | 2 | unlimited connected | unlimited |
| Concurrent jobs | fleet | fleet | **1 production slot** | unlimited |
| Users | multi | **1** | — | unlimited |
| Job queue | yes (assigns by availability) | **Pro+ only** | yes | yes |
| Talks to printers | yes, local | yes, 600+ models | yes, Bambu needs no agent | **no** |
| Slicing | via Studio | cloud slicing (15/mo) | cloud slicing | no |
| Clients / due dates / quoting | no | no | **no** | **yes** |
| Orders | no | no | e-commerce only (Shopify/Etsy/eBay) | planned |
| Hosting | local desktop, Windows | vendor cloud | vendor cloud | **your own** |

Read the last two rows together, because that is the whole argument.

**On machines, we lose, badly.** All three connect to printers, monitor them
and slice. We do none of that, and phase 4 would be a pale imitation of any of
them. Do not chase this.

**On the business layer, nobody is there.** Per their own documentation,
neither SimplyPrint nor Printago models clients, due dates, quoting or
invoicing. Printago's "orders" are *e-commerce* orders pulled from Shopify or
Etsy — a fundamentally different shape from "a customer dropped off a part on
Tuesday and needs it Thursday, quote them for it". Farm Manager has no concept
of a customer at all.

**And both free tiers break on this exact target** (1-3 printers, 2-3 staff):
SimplyPrint free is **one user** with the **queue behind Pro+**; Printago free
runs **one concurrent job**, so a three-printer shop idles two machines. Both
are cloud-only, so business data lives on a vendor's servers under a pricing
page that can change.

The honest pitch is therefore **not** "replaces Farm Manager". It is:

> Bambu Studio slices, Farm Manager drives the machines, and Printflow replaces
> the spreadsheet that currently tracks who wants what and when it is due.

Anyone claiming this removes a fleet tool is overselling it.

### Distribution — free, open source, self-hosted

Not a product to sell. The intended shape is a repo someone clones and deploys
to their own Cloudflare account, so it is free forever, the data stays theirs,
and there is no vendor to change terms.

That makes **setup friction the main adoption risk**, not features. The target
user runs a small print business; they are not necessarily someone who has
deployed a Worker. Two things matter more than any feature here:

- A **Deploy to Cloudflare** button wired to the repo, so the happy path is a
  click rather than a CLI session.
- A README that assumes no Cloudflare knowledge, and covers creating the D1
  database, applying migrations, and putting Access in front.

### What "managerial layer" actually means

Kept concrete, because "make it an ERP" is how small tools die of scope. Rough
order of value-per-effort for this workshop:

1. **Clients as real records.** `requestedBy` is a free-text string today.
   Promoting it to a table is the smallest change that unlocks everything
   below: per-client history, repeat work, contact details.
2. **Orders.** One drop-off is usually several plates. An order groups jobs, so
   a client asks "is my order ready?" and there is one answer instead of four.
3. **Costing.** Nearly free: we already store grams per plate and minutes per
   job. Filament cost per kg plus a machine-hour rate turns those into a price.
   This is the highest value for the least work.
4. **Delivery / collection status** — the state after "printed" that the board
   currently has nowhere to put.
5. **Analytics** — utilisation, throughput, failure rate.
6. **Invoicing / inventory** — real work, and only worth it if asked for. The
   xlsx writer already in `packages/shared` is the seed for documents.

Pick from this list against what the workshop actually complains about; do not
build it top to bottom.

**Commitment tracking came first, and deliberately.** The workshop's baseline
is a spreadsheet with a due-date column, which handles clients and notes
perfectly well. The first thing worth building was therefore the arithmetic a
spreadsheet cannot do: `computeDeadlinePressure` (latest safe slot) and
`promiseFinish` (quotable dates). Clients and costing only start paying off
once that is in daily use — do not reorder this without a reason.

### Phase 4 — telemetry, deliberately small

The printer work is a *supporting* feature now, not the destination. Its job is
to stop the managerial data lying: the "now printing" card and the projected
schedule currently estimate from start time plus the slicer's number, and drift
whenever a print runs long.

So phase 4 is **read-only telemetry** — live progress and remaining time — and
nothing else. That home already exists: the `printer_status` table
(`packages/db/src/schema.ts`) and the `printers.ip_address` / `access_code`
columns are unused, and the "now printing" card already prefers telemetry when
rows exist and falls back when they do not.

Start/pause/stop (phase 5) is deliberately *not* next. The printer's own
screen, Handy, and Farm Manager all already do it well, the risk of sending bad
commands to hardware is real, and it is the part most likely to break on a
firmware update. Do not build it without being asked.

**If sync ever comes up — Bambu Studio's "sync info" / model sync.** The client
uses that to pull model and printer information from their Bambu account. If it
is ever wired in, treat it as a *source of jobs* alongside `.3mf` upload, not a
replacement: `jobs.file_id` and `jobs.plate_id` are both nullable, so synced
work populates the same tables rather than growing a parallel path. Ask what
the button actually returns in their setup before designing against it.

## Page roles

One page, one role. This is deliberate — it means there is never a question of
where a control belongs, for the user or for whoever is tracking down a layout
bug later. Adding a feature to the wrong page is a design regression even if it
works.

| Page | Role | Layout |
| ---- | ---- | ------ |
| `/` | Operate the queue: order it, start and finish prints | full-bleed dashboard |
| `/intake` | Get work *in*: upload `.3mf`, add jobs by hand, register machines | centred, `width="readable"` |
| `/records` | Book-keeping: clients, history, paused jobs, filament and cost | centred, `width="readable"` |

`/printers` existed briefly and was folded back into intake: one short form and
a list did not justify splitting "setting up work" across two pages. Live
telemetry, when it lands, belongs on the board's printing panel — not a page.

**Any status that is not `backlog`, `queued` or `printing` has no lane on the
board.** `paused`, `done`, `failed` and `cancelled` render on `/records`. This
is not optional polish: without it, those actions look exactly like deleting.

The width comes from `Shell.astro`'s `width` prop. A page that sets a
`max-width` without centring leaves a dead strip down one side — that bug has
been fixed once already; don't reintroduce it in page-level CSS.

## Frontend constraints

- **No UI framework.** No React, Vue, or Svelte — the app is nowhere near the
  scale that justifies one. Pages are Astro; interactivity is vanilla TS in
  `src/scripts/`. Reach for a framework only if asked.
- Pages read D1 directly in frontmatter for first paint and hand the payload
  to a client script. Don't fetch our own API from a page's frontmatter.
- All client-side DOM lookups go through `src/scripts/dom.ts` (`qs` / `must` /
  `qsa` / `closest`), never the raw generic DOM methods. The reason is in that
  file's header comment — it is not stylistic.
- Drag-and-drop is plain HTML5 DnD. Every drop posts the destination lane's
  full id list to `POST /api/jobs/move`; the server rewrites that lane's
  positions. Don't switch to fractional indices.

## Stack

This project intentionally tracks the newest available versions, including
pre-releases. Training data lags behind these packages on purpose here -
**do not write code from memory for anything in this table.** Check the
actual installed version in `package.json` and that version's real
docs/changelog first, every time, even if you're confident you already know
the API.

| Package                        | Target             | Notes                                                                                          |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| `astro`                         | latest (7.x)        | Advanced Routing (`src/fetch.ts`), stable Route Caching, Rust compiler - astro.build/blog/astro-7 |
| `@astrojs/cloudflare`           | latest (14.x)        | Requires Astro 6+. Ships the Cloudflare Vite plugin - `astro dev` runs on real `workerd` with live bindings, not Node |
| `hono`                          | latest (4.13.x)      |                                                                                                    |
| `wrangler`                      | latest (4.120.x)     | Config file is `wrangler.jsonc`, not `wrangler.toml`                                             |
| `drizzle-orm` / `drizzle-kit`   | `@rc` (currently `1.0.0-rc.x`) | This is Drizzle's **v1 pre-release**, not the `0.x` line that most existing docs, blog posts, and training data describe. Check the changelog for the exact installed `rc` build - `0.x`-era examples may not apply. |

## Before you write code

1. Check `package.json` for the actual installed version of whatever
   you're about to touch. Don't assume from memory or from a version
   number mentioned earlier in the conversation.
2. Check that version's real docs or changelog before writing code, even
   for something that feels like well-trodden territory. "Confident" and
   "current" are not the same thing on this stack.
3. If what you're about to write matches a pattern this project has
   already deliberately moved away from (below), stop and ask instead of
   reintroducing it.

## Patterns this project has deliberately moved away from

Don't reintroduce these without asking first - they were tried and
rejected, not just skipped:

- **`@cloudflare/workers-types` + a hand-written `Env` interface.** Use
  `wrangler types` instead (the `types` script) - it generates
  `worker-configuration.d.ts` straight from the real bindings in
  `wrangler.jsonc`, so it can't drift out of sync with what's actually
  configured.
- **`wrangler.toml`.** Use `wrangler.jsonc`.
- **R2 for uploads or previews.** R2 requires a payment card on the Cloudflare
  account and this deployment does not have one. Previews live in the
  `plate_thumbnails` D1 table; the original `.3mf` is parsed and discarded. Do
  not reintroduce a bucket binding without checking that first.
- **Swapping D1 for Neon/Postgres to work around R2.** Neon replaces D1, which
  is relational; it does not replace object storage. Going Postgres would mean
  rewriting every `sqliteTable` in `packages/db/src/schema.ts`, regenerating
  every migration and swapping the driver - a large change that would not have
  solved the blob problem.
- **A separate Worker app + a static Astro build + a manual dev-time
  proxy between them.** With `@astrojs/cloudflare` on Astro 6/7, one
  Astro project *is* the Worker. `astro dev` already runs on real
  `workerd` with live D1 bindings - no second process, no proxy
  config.
- **A standalone Node.js process querying D1 over its HTTP API, or a
  `sqlite-proxy` shim for Drizzle.** `drizzle-orm`'s D1 driver needs a
  real Worker binding to run against. That path was evaluated and
  rejected - see the repo's `README.md` for why.
- **Astro 5-era SSR/adapter assumptions in general.** A Node adapter, no
  Advanced Routing, no route caching - if what you're writing looks like
  it belongs in an Astro 5 tutorial, stop and check what's actually
  installed.
- **`cf()` from `@astrojs/cloudflare/hono` in `src/fetch.ts`.** Tried; it
  500s every request. See the gotcha section below for why and for what to
  use instead.

## Cloudflare-specific gotcha: bindings in `src/fetch.ts`

The Advanced Routing examples in the Astro 7 blog post (`astro/hono`'s
`astro()` helper) are platform-agnostic and don't show Cloudflare-specific
setup. That much is true — but the fix is **not** `cf()`.

**Do not add `cf()` from `@astrojs/cloudflare/hono` to `src/fetch.ts`.** It
breaks every request with a 500. Verified against the installed versions,
not assumed:

- Astro invokes the fetch handler as `fetch(request)` — a single argument.
  See `FetchHandler` in `astro/dist/core/fetch/types.d.ts`, and the
  `#fetchHandler.fetch(request)` call in `astro/dist/core/app/base.js`.
- Hono therefore never receives Cloudflare's `(env, ctx)` arguments. Probing
  the context inside `src/fetch.ts` gives `c.env === undefined`, and reading
  `c.executionCtx` throws `This context has no ExecutionContext`.
- `cf()` reads exactly those two (`@astrojs/cloudflare/dist/hono.js`), so it
  throws on the first request and takes the whole app down with it.

`cf()` is for a **custom worker entrypoint** — where wrangler's `main` points
at your own file and Hono itself is the Worker, so workerd hands it
`(request, env, ctx)` directly. That is a different arrangement from this
project's, and it is not reachable from here: `astro()` resolves its app via
a symbol that `app.render()` attaches to the request, so Hono in
`src/fetch.ts` is called *by* Astro, not the other way round. Swapping to a
custom entrypoint would mean giving up `src/fetch.ts` and driving
`createApp()`/`handle()` by hand.

**The correct way to reach bindings here is `import { env } from
"cloudflare:workers"`** (see `apps/web/src/server/context.ts`). This is the
adapter's own supported path — its internal handler does the same thing, and
touching `Astro.locals.runtime.env` throws an error whose text points you
straight at it:

> `Astro.locals.runtime.env` has been removed in Astro v6. Use
> `import { env } from "cloudflare:workers"` instead.

So the real warning stands, just with a different conclusion: don't copy the
blog's generic Hono example and assume it covers bindings. It doesn't — but
the missing piece is the `cloudflare:workers` import in the server modules,
not middleware in `src/fetch.ts`.

If this project ever *does* move to a custom worker entrypoint, this section
needs rewriting rather than amending — `cf()` becomes correct and required at
that point.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

### Never run `astro build` or `astro check` while the dev server is up

They share `node_modules/.vite` with the running server. A build or check
re-runs the dependency optimizer and rewrites that cache, and the live server
is left holding hashes that no longer exist on disk. Every request then 500s
with:

> The file does not exist at `.../node_modules/.vite/deps_ssr/@astrojs_cloudflare_entrypoints_server.js?v=<hash>` ... Try adding it to `optimizeDeps.exclude`

The message points at `optimizeDeps.exclude`, which is a red herring — nothing
is misconfigured and adding an exclude does not help. This is reproducible on
demand: note the `hash` in `node_modules/.vite/deps_ssr/_metadata.json`, run
`astro build` with the server running, and watch the hash change while the
server keeps serving the old one.

The fix, and the order matters:

```
astro dev stop && rm -rf node_modules/.vite .astro && astro dev --background
```

So: stop the dev server before building or typechecking, or run them from a
separate checkout. `pnpm build` chains `wrangler types && astro check &&
astro build`, so it trips this three ways over.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
- [Cloudflare adapter (bindings, Vite plugin, Hono integration)](https://docs.astro.build/en/guides/integrations-guide/cloudflare/)
- [Route caching](https://docs.astro.build/en/guides/caching/)
- [Drizzle ORM changelog](https://github.com/drizzle-team/drizzle-orm/releases) - check before assuming `rc` API shape
