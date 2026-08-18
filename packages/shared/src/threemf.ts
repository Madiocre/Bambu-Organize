/**
 * Reads the metadata Bambu Studio bakes into a .3mf.
 *
 * A .3mf saved by Bambu Studio is a zip laid out roughly like this:
 *
 *   3D/3dmodel.model                 the actual geometry (we never read it)
 *   Metadata/slice_info.config       XML: per-plate print time, weight, filaments  <- the one that matters
 *   Metadata/model_settings.config   XML: plate names, object names, thumbnail paths
 *   Metadata/project_settings.config JSON: the full slicing profile
 *   Metadata/plate_1.png             plate preview render
 *   Metadata/plate_1_small.png       thumbnail
 *   Metadata/plate_1.gcode           only present in a *sliced* export
 *
 * `slice_info.config` is written by the slicer at slice time, so its
 * `prediction` (seconds) is exactly the estimate Bambu Studio shows and the
 * printer counts down from. That is what we hang the queue's scheduling on.
 * Everything else here is either a scheduling input (filament grams, model
 * compatibility) or UI garnish (plate preview, object names).
 *
 * The config files are small, machine-generated, attribute-only XML with no
 * namespaces, comments, or CDATA - so a regex pass is a legitimate reader
 * here, and it saves shipping an XML parser to workerd. If Bambu ever starts
 * nesting real content in these, this is the file to rewrite.
 */

import { ZipArchive } from "./zip.js";

export interface ThreeMfFilament {
  /** 1-based extruder / AMS slot as recorded in the file */
  id: number;
  /** Bambu filament catalogue id, e.g. "GFA00" for Bambu PLA Basic */
  trayInfoIdx?: string;
  /** "PLA", "PETG", "ABS", ... */
  type?: string;
  /** Normalised to #RRGGBB; the file may carry an extra alpha byte */
  colorHex?: string;
  usedM?: number;
  usedG?: number;
}

export interface ThreeMfObject {
  identifyId?: string;
  name?: string;
  skipped: boolean;
}

export interface ThreeMfPlate {
  /** 1-based plate number, as used in the plate_N.* filenames */
  index: number;
  /** Plate name from model_settings.config, when the user set one */
  name?: string;
  /** Slicer's print-time estimate in seconds - the queue's primary duration input */
  predictionSec?: number;
  /** Total filament mass for the plate */
  weightG?: number;
  /** `printer_model_id`, e.g. "BL-P001" - join key against our printers table */
  printerModelCode?: string;
  /** One diameter per extruder, comma separated on multi-extruder machines */
  nozzleDiameters?: string;
  timelapseType?: number;
  supportUsed?: boolean;
  /** Object skipping / per-object labelling was enabled at slice time */
  labelObjectEnabled?: boolean;
  /** Slicer flagged geometry outside the build area */
  outside?: boolean;
  objects: ThreeMfObject[];
  filaments: ThreeMfFilament[];
  /** Zip entry for the plate's gcode, present only in sliced exports */
  gcodePath?: string;
  /** Zip entry for the plate preview PNG, if the file carries one */
  thumbnailPath?: string;
}

export interface ThreeMfProfile {
  /** Human name from the profile, e.g. "Bambu Lab P1P" */
  printerModel?: string;
  printerSettingsId?: string;
  layerHeightMm?: number;
  nozzleDiameterMm?: number;
  bedType?: string;
  filamentTypes?: string[];
  filamentColors?: string[];
}

export interface ThreeMfMetadata {
  slicer?: { client?: string; version?: string };
  plates: ThreeMfPlate[];
  profile?: ThreeMfProfile;
  /** True when the archive contains plate gcode, i.e. it can be sent to a printer as-is */
  hasGcode: boolean;
  totalPredictionSec: number;
  totalWeightG: number;
  /** Non-fatal problems worth surfacing on the upload screen */
  warnings: string[];
}

const SLICE_INFO = "Metadata/slice_info.config";
const MODEL_SETTINGS = "Metadata/model_settings.config";
const PROJECT_SETTINGS = "Metadata/project_settings.config";

export async function parseThreeMf(bytes: Uint8Array): Promise<ThreeMfMetadata> {
  const zip = ZipArchive.open(bytes);
  const warnings: string[] = [];

  const sliceInfo = await zip.readText(SLICE_INFO);
  if (!sliceInfo) {
    // A .3mf saved before slicing has geometry but no estimates. Still worth
    // keeping as a file record - the user just has to type a duration.
    warnings.push(
      "No slice_info.config in this .3mf - it was saved before slicing, so there is no print-time estimate. Slice it in Bambu Studio and re-export, or enter the duration by hand.",
    );
  }

  const { slicer, plates } = sliceInfo ? parseSliceInfo(sliceInfo) : { slicer: undefined, plates: [] };

  const modelSettings = await zip.readText(MODEL_SETTINGS);
  const plateNames = modelSettings ? parsePlateNames(modelSettings) : new Map<number, PlateExtras>();

  for (const plate of plates) {
    const extras = plateNames.get(plate.index);
    if (extras?.name) plate.name = extras.name;

    const gcodePath = `Metadata/plate_${plate.index}.gcode`;
    if (zip.has(gcodePath)) plate.gcodePath = gcodePath;

    // Prefer whatever model_settings points at, then the conventional names.
    const thumbnailCandidates = [
      extras?.thumbnailFile,
      `Metadata/plate_${plate.index}.png`,
      `Metadata/plate_${plate.index}_small.png`,
    ].filter((c): c is string => Boolean(c));
    plate.thumbnailPath = thumbnailCandidates.find((c) => zip.has(c));

    if (plate.predictionSec === undefined) {
      warnings.push(`Plate ${plate.index} has no print-time estimate in the file.`);
    }
    if (plate.outside) {
      warnings.push(`Plate ${plate.index} has objects outside the build area.`);
    }
  }

  if (sliceInfo && plates.length === 0) {
    warnings.push("slice_info.config contained no plates.");
  }

  const projectSettings = await zip.readText(PROJECT_SETTINGS);
  const profile = projectSettings ? parseProjectSettings(projectSettings, warnings) : undefined;

  return {
    slicer,
    plates,
    profile,
    hasGcode: plates.some((p) => p.gcodePath) || zip.find((n) => n.endsWith(".gcode")).length > 0,
    totalPredictionSec: plates.reduce((sum, p) => sum + (p.predictionSec ?? 0), 0),
    totalWeightG: plates.reduce((sum, p) => sum + (p.weightG ?? 0), 0),
    warnings,
  };
}

/** Pulls a plate preview out of an already-read .3mf, for storing alongside the file. */
export async function readThreeMfEntry(
  bytes: Uint8Array,
  entryName: string,
): Promise<Uint8Array | undefined> {
  return ZipArchive.open(bytes).read(entryName);
}

// --- XML scraping -----------------------------------------------------------

const ATTR_RE = /([\w:-]+)\s*=\s*"([^"]*)"/g;

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(tag)) !== null) {
    out[match[1]!] = decodeXmlEntities(match[2]!);
  }
  return out;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

/** `<metadata key="x" value="y"/>` pairs inside one block. */
function metadataMap(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of block.matchAll(/<metadata\b[^>]*\/?>/g)) {
    const a = attrs(match[0]);
    if (a.key !== undefined) map.set(a.key, a.value ?? "");
  }
  return map;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

/** "#RRGGBB" from "#RRGGBBAA", "RRGGBB", or a already-fine "#RRGGBB". */
function normaliseColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6,8}$/.test(hex)) return undefined;
  return `#${hex.slice(0, 6).toUpperCase()}`;
}

function parseSliceInfo(xml: string): {
  slicer?: { client?: string; version?: string };
  plates: ThreeMfPlate[];
} {
  const header: Record<string, string> = {};
  for (const match of xml.matchAll(/<header_item\b[^>]*\/?>/g)) {
    const a = attrs(match[0]);
    if (a.key) header[a.key] = a.value ?? "";
  }

  const plates: ThreeMfPlate[] = [];
  for (const match of xml.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/g)) {
    const block = match[1]!;
    const meta = metadataMap(block);

    const objects: ThreeMfObject[] = [];
    for (const objMatch of block.matchAll(/<object\b[^>]*\/?>/g)) {
      const a = attrs(objMatch[0]);
      objects.push({
        identifyId: a.identify_id,
        name: a.name,
        skipped: bool(a.skipped) ?? false,
      });
    }

    const filaments: ThreeMfFilament[] = [];
    for (const filMatch of block.matchAll(/<filament\b[^>]*\/?>/g)) {
      const a = attrs(filMatch[0]);
      filaments.push({
        id: num(a.id) ?? filaments.length + 1,
        trayInfoIdx: a.tray_info_idx,
        type: a.type,
        colorHex: normaliseColor(a.color),
        usedM: num(a.used_m),
        usedG: num(a.used_g),
      });
    }

    plates.push({
      index: num(meta.get("index")) ?? plates.length + 1,
      predictionSec: num(meta.get("prediction")),
      weightG: num(meta.get("weight")),
      printerModelCode: meta.get("printer_model_id") || undefined,
      nozzleDiameters: meta.get("nozzle_diameters") || undefined,
      timelapseType: num(meta.get("timelapse_type")),
      supportUsed: bool(meta.get("support_used")),
      labelObjectEnabled: bool(meta.get("label_object_enabled")),
      outside: bool(meta.get("outside")),
      objects,
      filaments,
    });
  }

  plates.sort((a, b) => a.index - b.index);

  const client = header["X-BBL-Client-Type"];
  const version = header["X-BBL-Client-Version"];
  return {
    slicer: client || version ? { client, version } : undefined,
    plates,
  };
}

interface PlateExtras {
  name?: string;
  thumbnailFile?: string;
}

/**
 * model_settings.config carries the user-facing plate name and the slicer's
 * own idea of where the preview image lives. Both are optional.
 */
function parsePlateNames(xml: string): Map<number, PlateExtras> {
  const out = new Map<number, PlateExtras>();
  for (const match of xml.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/g)) {
    const meta = metadataMap(match[1]!);
    const id = num(meta.get("plater_id"));
    if (id === undefined) continue;
    out.set(id, {
      name: meta.get("plater_name") || undefined,
      thumbnailFile: meta.get("thumbnail_file") || undefined,
    });
  }
  return out;
}

function parseProjectSettings(json: string, warnings: string[]): ThreeMfProfile | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    warnings.push("project_settings.config was not valid JSON; slicing profile details were skipped.");
    return undefined;
  }

  // Bambu writes almost everything as strings, and most per-extruder values
  // as arrays of strings, so read defensively rather than trusting types.
  const str = (key: string): string | undefined => {
    const value = raw[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const strArray = (key: string): string[] | undefined => {
    const value = raw[key];
    if (!Array.isArray(value)) return undefined;
    const items = value.filter((v): v is string => typeof v === "string");
    return items.length ? items : undefined;
  };
  const firstNum = (key: string): number | undefined => {
    const value = raw[key];
    if (Array.isArray(value)) return num(typeof value[0] === "string" ? value[0] : String(value[0]));
    if (typeof value === "number") return value;
    if (typeof value === "string") return num(value);
    return undefined;
  };

  return {
    printerModel: str("printer_model"),
    printerSettingsId: str("printer_settings_id"),
    layerHeightMm: firstNum("layer_height"),
    nozzleDiameterMm: firstNum("nozzle_diameter"),
    bedType: str("curr_bed_type"),
    filamentTypes: strArray("filament_type"),
    filamentColors: strArray("filament_colour")?.map((c) => normaliseColor(c) ?? c),
  };
}
