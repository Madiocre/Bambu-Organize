import { astro } from 'astro/hono';
import { Hono } from 'hono';
import { filesRouter } from './server/routes/files.js';
import { jobsRouter } from './server/routes/jobs.js';
import { printersRouter } from './server/routes/printers.js';
import { recordsRouter } from './server/routes/records.js';

/**
 * The whole app's entrypoint. Astro calls this for every request (see
 * `virtual:astro:fetchable`), so anything mounted before `astro()` wins over
 * page routing - which is where the JSON API lives.
 *
 * Bindings are not available on `c.env` here: Astro hands the fetch handler a
 * bare `Request`, so `env` comes from `cloudflare:workers` inside
 * `src/server/context.ts` instead.
 *
 * No auth yet. The scaffold shipped with a hardcoded basic-auth pair, which
 * would have locked out every request the moment real routes existed; a real
 * login belongs with the printer-control phase, not before it.
 */
const app = new Hono();

app.route('/api/jobs', jobsRouter);
app.route('/api/printers', printersRouter);
app.route('/api/files', filesRouter);
app.route('/api/records', recordsRouter);

app.onError((error, c) => {
  console.error('Unhandled API error', error);
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'Something went wrong handling that request' }, 500);
  }
  throw error;
});

app.use(astro());

export default app;
