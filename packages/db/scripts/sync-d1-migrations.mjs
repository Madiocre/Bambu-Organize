/**
 * drizzle-kit 1.x writes each migration as `migrations/<stamp>_<name>/migration.sql`
 * plus a snapshot; `wrangler d1 migrations apply` wants a flat directory of
 * `<stamp>_<name>.sql` files and nothing else. Rather than pick one and lose
 * the other, we keep drizzle's directory as the source of truth and mirror it
 * into `migrations-d1/` for wrangler.
 *
 * Run after every `pnpm --filter @bambu-organize/db generate` (the `generate`
 * script already chains it).
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(packageRoot, "migrations");
const target = join(packageRoot, "migrations-d1");

const entries = await readdir(source, { withFileTypes: true });
const migrations = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const migration of migrations) {
  const sql = await readFile(join(source, migration.name, "migration.sql"), "utf8");
  await writeFile(join(target, `${migration.name}.sql`), sql);
}

console.log(`Mirrored ${migrations.length} migration(s) into migrations-d1/`);
