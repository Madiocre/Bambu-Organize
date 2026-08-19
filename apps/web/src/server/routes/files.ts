import { Hono } from "hono";
import { and, asc, eq, inArray } from "drizzle-orm";
import { filePlates, plateFilaments, plateThumbnails, printFiles } from "@bambu-organize/db";
import { parseThreeMf, readThreeMfEntry, type ThreeMfMetadata } from "@bambu-organize/shared";
import { getDb, newId, now } from "../context.js";
import { badRequest } from "../http.js";

export const filesRouter = new Hono();

/**
 * Workers cap request bodies at 100MB, and the zip reader needs the whole
 * archive in memory to walk the central directory. 64MB is comfortably above
 * any real .3mf while leaving isolate headroom - a bigger file almost always
 * means someone dropped the wrong thing on the page.
 */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/**
 * D1 caps any single row at 2MB. Real plate previews are 18-22KB, so this is
 * a sanity bound rather than a real constraint - it only trips if a future
 * slicer starts embedding something far larger, in which case dropping the
 * preview is better than failing the whole upload.
 */
const MAX_THUMBNAIL_BYTES = 1024 * 1024;

/** Parse without persisting - lets the intake page preview a drop before committing. */
filesRouter.post("/inspect", async (c) => {
  const upload = await readUpload(c.req.raw);
  if ("error" in upload) return badRequest(c, upload.error);

  try {
    const metadata = await parseThreeMf(upload.bytes);
    return c.json({ filename: upload.filename, sizeBytes: upload.bytes.byteLength, metadata });
  } catch (error) {
    return badRequest(c, `Could not read that .3mf: ${(error as Error).message}`);
  }
});

filesRouter.post("/", async (c) => {
  const upload = await readUpload(c.req.raw);
  if ("error" in upload) return badRequest(c, upload.error);

  let metadata: ThreeMfMetadata;
  try {
    metadata = await parseThreeMf(upload.bytes);
  } catch (error) {
    return badRequest(c, `Could not read that .3mf: ${(error as Error).message}`);
  }

  // The app requires a sliced file: `prediction` is the only print time the
  // format carries, and it is written by the slicer. Rejecting here rather
  // than after the insert keeps zero-plate records out of the library, where
  // they would look like a broken upload rather than an unsliced one.
  if (!metadata.hasSliceResults) {
    return badRequest(
      c,
      "This .3mf has not been sliced, so it carries no print times. Open it in Bambu Studio, slice the plate, then save the project and upload it again.",
    );
  }

  const db = getDb();
  const sha256 = await digest(upload.bytes);

  // Re-uploading the same export is common (someone re-downloads it from
  // chat). Hand back the existing record rather than duplicating the plates.
  const [existing] = await db.select().from(printFiles).where(eq(printFiles.sha256, sha256));
  if (existing) {
    return c.json({ file: existing, plates: await loadPlates(existing.id), metadata, deduped: true });
  }

  const fileId = newId();
  const timestamp = now();

  // The original archive is deliberately not kept. It was written to R2 and
  // never read back by anything, and it cannot live in D1 either - real files
  // here run 1.3-4.9MB against a 2MB row ceiling. Only the parsed metadata and
  // the preview are worth storing; re-upload is the recovery path. If the
  // printer-control phase ever needs to send the file, that is the point to
  // add object storage back.
  const fileRow = {
    id: fileId,
    filename: upload.filename,
    sizeBytes: upload.bytes.byteLength,
    sha256,
    kind: metadata.hasGcode ? ("sliced" as const) : ("project" as const),
    slicerName: metadata.slicer?.client ?? null,
    slicerVersion: metadata.slicer?.version ?? null,
    plateCount: metadata.plates.length,
    createdAt: timestamp,
  };
  await db.insert(printFiles).values(fileRow);

  const plateRows = [];
  const filamentRows = [];
  const thumbnailRows = [];
  for (const plate of metadata.plates) {
    const plateId = newId();

    // Pull the plate preview out of the zip once, now, so the board never has
    // to re-inflate the archive - which it could not do anyway, since the
    // archive is not kept.
    let thumbnail: { plateId: string; contentType: string; dataBase64: string; sizeBytes: number } | null =
      null;
    if (plate.thumbnailPath) {
      const png = await readThreeMfEntry(upload.bytes, plate.thumbnailPath);
      if (png && png.byteLength <= MAX_THUMBNAIL_BYTES) {
        thumbnail = {
          plateId,
          contentType: "image/png",
          dataBase64: toBase64(png),
          sizeBytes: png.byteLength,
        };
      }
    }
    if (thumbnail) thumbnailRows.push(thumbnail);

    plateRows.push({
      id: plateId,
      fileId,
      plateIndex: plate.index,
      name: plate.name ?? null,
      predictionSec: plate.predictionSec ?? null,
      weightG: plate.weightG ?? null,
      printerModelCode: plate.printerModelCode ?? null,
      nozzleDiameters: plate.nozzleDiameters ?? null,
      supportUsed: plate.supportUsed ?? false,
      labelObjectEnabled: plate.labelObjectEnabled ?? false,
      objectCount: plate.objects.length,
      gcodePath: plate.gcodePath ?? null,
      hasThumbnail: thumbnail !== null,
    });

    for (const filament of plate.filaments) {
      filamentRows.push({
        id: newId(),
        plateId,
        filamentIndex: filament.id,
        trayInfoIdx: filament.trayInfoIdx ?? null,
        type: filament.type ?? null,
        colorHex: filament.colorHex ?? null,
        usedM: filament.usedM ?? null,
        usedG: filament.usedG ?? null,
      });
    }
  }

  if (plateRows.length > 0) await db.insert(filePlates).values(plateRows);
  if (filamentRows.length > 0) await db.insert(plateFilaments).values(filamentRows);
  // One row at a time: each carries ~30KB of base64 and D1 caps a statement at
  // 100KB, so batching them would overflow it.
  for (const row of thumbnailRows) await db.insert(plateThumbnails).values(row);

  return c.json({ file: fileRow, plates: await loadPlates(fileId), metadata, deduped: false }, 201);
});

filesRouter.get("/", async (c) => {
  const db = getDb();
  const files = await db.select().from(printFiles).orderBy(asc(printFiles.createdAt));
  if (files.length === 0) return c.json([]);

  const plates = await db
    .select()
    .from(filePlates)
    .where(inArray(filePlates.fileId, files.map((f) => f.id)));
  const filaments = plates.length
    ? await db
        .select()
        .from(plateFilaments)
        .where(inArray(plateFilaments.plateId, plates.map((p) => p.id)))
    : [];

  const filamentsByPlate = new Map<string, typeof filaments>();
  for (const filament of filaments) {
    const list = filamentsByPlate.get(filament.plateId) ?? [];
    list.push(filament);
    filamentsByPlate.set(filament.plateId, list);
  }

  return c.json(
    files
      .map((file) => ({
        ...file,
        plates: plates
          .filter((plate) => plate.fileId === file.id)
          .sort((a, b) => a.plateIndex - b.plateIndex)
          .map((plate) => ({ ...plate, filaments: filamentsByPlate.get(plate.id) ?? [] })),
      }))
      .reverse(),
  );
});

filesRouter.get("/:id/plates/:index/thumbnail", async (c) => {
  const index = Number.parseInt(c.req.param("index") ?? "", 10);
  if (!Number.isFinite(index)) return c.notFound();

  const db = getDb();
  const [plate] = await db
    .select({ id: filePlates.id })
    .from(filePlates)
    .where(and(eq(filePlates.fileId, c.req.param("id")), eq(filePlates.plateIndex, index)));
  if (!plate) return c.notFound();

  const [row] = await db
    .select()
    .from(plateThumbnails)
    .where(eq(plateThumbnails.plateId, plate.id));
  if (!row) return c.notFound();

  return new Response(fromBase64(row.dataBase64), {
    headers: {
      "Content-Type": row.contentType,
      // Keyed by file id, and files are immutable once uploaded.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

filesRouter.delete("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");

  const [file] = await db.select().from(printFiles).where(eq(printFiles.id, id));
  if (!file) return c.json({ error: "No such file" }, 404);

  // Plates, filaments and thumbnails all hang off the file by ON DELETE
  // CASCADE, so one delete is now the whole cleanup - there are no external
  // objects left to orphan.
  await db.delete(printFiles).where(eq(printFiles.id, id));

  return c.json({ ok: true });
});

async function loadPlates(fileId: string) {
  const db = getDb();
  const plates = await db
    .select()
    .from(filePlates)
    .where(eq(filePlates.fileId, fileId))
    .orderBy(asc(filePlates.plateIndex));
  if (plates.length === 0) return [];

  const filaments = await db
    .select()
    .from(plateFilaments)
    .where(inArray(plateFilaments.plateId, plates.map((p) => p.id)));

  return plates.map((plate) => ({
    ...plate,
    filaments: filaments
      .filter((f) => f.plateId === plate.id)
      .sort((a, b) => a.filamentIndex - b.filamentIndex),
  }));
}

type Upload = { filename: string; bytes: Uint8Array<ArrayBuffer> } | { error: string };

async function readUpload(request: Request): Promise<Upload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return { error: "Send the .3mf as multipart/form-data with a `file` field" };
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return { error: "No `file` field in the upload" };
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: `That file is ${Math.round(file.size / 1e6)}MB; the limit is 64MB` };
  }
  if (!/\.3mf$/i.test(file.name)) {
    return { error: "Only .3mf files carry the metadata we need - export one from Bambu Studio" };
  }

  return { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

// `Uint8Array` defaults to `Uint8Array<ArrayBufferLike>`, which would admit a
// SharedArrayBuffer view and so is not a `BufferSource`. Uploads always come
// from `file.arrayBuffer()`, so the tighter type is accurate, not a workaround.
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Chunked so a ~22KB preview does not blow the argument limit of
 * `String.fromCharCode` on the spread path.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
