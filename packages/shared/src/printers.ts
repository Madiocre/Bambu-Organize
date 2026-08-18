/**
 * Bambu Lab machine catalogue.
 *
 * `code` is the value Bambu Studio writes as `printer_model_id` into a
 * .3mf's `Metadata/slice_info.config`, and the same value the printer
 * reports over MQTT/HTTP. It is the only stable join key between "a file
 * someone dropped on us" and "a machine we know about", so it is what we
 * store on `printers.model_code` rather than a friendly name.
 *
 * Values are transcribed from BambuStudio's own profiles
 * (resources/profiles/BBL/machine/*.json -> `model_id`). Unknown codes are
 * never an error: `lookupPrinterModel` returns undefined and the UI falls
 * back to showing the raw code, so a printer released after this table was
 * written still schedules fine - it just doesn't get a pretty label.
 */
export interface PrinterModel {
  /** `printer_model_id` from slice_info.config, e.g. "BL-P001" */
  code: string;
  name: string;
  /** Short label for dense UI (queue cards, chips) */
  short: string;
  /** Build volume in mm; undefined where the profile inherits it and we did not verify */
  bed?: { x: number; y: number; z: number };
  /** H2D-class machines have two independent extruders */
  extruders: number;
  /** Whether AMS is standard rather than an add-on - informational only */
  amsStandard: boolean;
}

export const PRINTER_MODELS: readonly PrinterModel[] = [
  { code: "BL-P001", name: "Bambu Lab X1 Carbon", short: "X1C", bed: { x: 256, y: 256, z: 256 }, extruders: 1, amsStandard: false },
  { code: "BL-P002", name: "Bambu Lab X1", short: "X1", bed: { x: 256, y: 256, z: 256 }, extruders: 1, amsStandard: false },
  { code: "C13", name: "Bambu Lab X1E", short: "X1E", bed: { x: 256, y: 256, z: 256 }, extruders: 1, amsStandard: false },
  { code: "C11", name: "Bambu Lab P1P", short: "P1P", bed: { x: 256, y: 256, z: 256 }, extruders: 1, amsStandard: false },
  { code: "C12", name: "Bambu Lab P1S", short: "P1S", bed: { x: 256, y: 256, z: 256 }, extruders: 1, amsStandard: false },
  { code: "N7", name: "Bambu Lab P2S", short: "P2S", bed: { x: 256, y: 256, z: 256 }, extruders: 1, amsStandard: false },
  { code: "N1", name: "Bambu Lab A1 mini", short: "A1 mini", bed: { x: 180, y: 180, z: 180 }, extruders: 1, amsStandard: false },
  { code: "N2S", name: "Bambu Lab A1", short: "A1", bed: { x: 256, y: 256, z: 256 }, extruders: 1, amsStandard: false },
  { code: "N9", name: "Bambu Lab A2L", short: "A2L", bed: { x: 330, y: 320, z: 325 }, extruders: 1, amsStandard: false },
  { code: "N6", name: "Bambu Lab X2D", short: "X2D", bed: { x: 256, y: 256, z: 261 }, extruders: 2, amsStandard: true },
  { code: "O1D", name: "Bambu Lab H2D", short: "H2D", bed: { x: 350, y: 320, z: 325 }, extruders: 2, amsStandard: false },
  { code: "O1E", name: "Bambu Lab H2D Pro", short: "H2D Pro", bed: { x: 350, y: 320, z: 325 }, extruders: 2, amsStandard: false },
  { code: "O1S", name: "Bambu Lab H2S", short: "H2S", bed: { x: 340, y: 320, z: 340 }, extruders: 1, amsStandard: false },
  { code: "O1C2", name: "Bambu Lab H2C", short: "H2C", bed: { x: 330, y: 320, z: 325 }, extruders: 2, amsStandard: false },
];

const BY_CODE = new Map(PRINTER_MODELS.map((m) => [m.code, m]));

export function lookupPrinterModel(code: string | null | undefined): PrinterModel | undefined {
  if (!code) return undefined;
  return BY_CODE.get(code);
}

/** Friendly name for a model code, falling back to the raw code for machines we don't know yet. */
export function printerModelLabel(code: string | null | undefined): string {
  if (!code) return "Any printer";
  return BY_CODE.get(code)?.short ?? code;
}

export type NozzleCompatibility = "match" | "mismatch" | "unknown";

/**
 * Whether a plate sliced for `plateModelCode` at `plateNozzles` can run on a
 * given printer. Deliberately three-valued: a file with no model recorded
 * (hand-built gcode, an old export) is "unknown" and stays schedulable with
 * a warning rather than being rejected outright.
 */
export function checkCompatibility(
  plate: { printerModelCode?: string | null; nozzleDiameters?: string | null },
  printer: { modelCode: string; nozzleDiameterMm: number },
): { model: NozzleCompatibility; nozzle: NozzleCompatibility } {
  const model: NozzleCompatibility = !plate.printerModelCode
    ? "unknown"
    : plate.printerModelCode === printer.modelCode
      ? "match"
      : "mismatch";

  let nozzle: NozzleCompatibility = "unknown";
  if (plate.nozzleDiameters) {
    // Multi-extruder machines write one diameter per extruder, comma separated.
    const diameters = plate.nozzleDiameters
      .split(/[,;]/)
      .map((d) => Number.parseFloat(d.trim()))
      .filter((d) => Number.isFinite(d));
    if (diameters.length > 0) {
      nozzle = diameters.every((d) => Math.abs(d - printer.nozzleDiameterMm) < 0.001)
        ? "match"
        : "mismatch";
    }
  }

  return { model, nozzle };
}
