//-----------------------------------------------------------------------
// Orchestration: config + imported data → all artifacts (engine values,
// workbook sheets, CSV exports). Used by the wizard and by the tests.
//-----------------------------------------------------------------------

import { buildDataset, detectStep, type ImportStats } from "./import";
import { buildPlan } from "./engine";
import { buildMeteoSheet } from "./meteo";
import { buildEpiResults, buildPrResults } from "./results";
import { mappedSensors } from "./params";
import type { Artifacts } from "./workbook";
import type { Dataset, MeterTable, ModelConfig, PvsystTable, RawTable } from "./types";

export interface Inputs {
    cfg: ModelConfig;
    /** Either a raw SCADA table (new model) or a dataset restored from a saved workbook. */
    raw?: RawTable | null;
    restored?: { ds: Dataset; stats: ImportStats } | null;
    pvsyst?: PvsystTable | null;
    meter?: MeterTable | null;
    sources?: Artifacts["sources"];
}

export function runModel(inp: Inputs): Artifacts & { stats: ImportStats } {
    const { cfg } = inp;
    let ds: Dataset, stats: ImportStats;
    if (inp.raw) ({ ds, stats } = buildDataset(inp.raw, cfg));
    else if (inp.restored) ({ ds, stats } = inp.restored);
    else throw new Error("Load the SCADA data first.");
    if (!ds.t.length) throw new Error("No SCADA rows left after import. Check the date column and the test period.");
    const plan = buildPlan(cfg, ds);
    const out: Artifacts & { stats: ImportStats } = { plan, stats, sources: inp.sources };
    if (cfg.type === "EPI") {
        out.meteo = buildMeteoSheet(plan);
        const meterReady = cfg.meter.source === "scada" ? true : !!inp.meter;
        if (inp.pvsyst && meterReady) out.epi = buildEpiResults(plan, inp.pvsyst, inp.meter ?? null);
    } else {
        out.pr = buildPrResults(plan);
    }
    return out;
}

/** Rebuild the dataset from the data sheet of a saved (internal) workbook. */
export function datasetFromSheet(cfg: ModelConfig, sheet: { headers: string[]; rows: (number | string | null)[][] }): { ds: Dataset; stats: ImportStats } {
    const di = sheet.headers.indexOf("Date");
    const fi = sheet.headers.indexOf("Problematic_Flag");
    if (di < 0) throw new Error("The saved workbook has no Date column.");
    const rows = sheet.rows.filter((r) => typeof r[di] === "number");
    const t = rows.map((r) => Math.round((r[di] as number) * 1440));
    const cols: Dataset["cols"] = {};
    for (const s of mappedSensors(cfg.mapping)) {
        const j = sheet.headers.indexOf(s.name);
        cols[s.name] = rows.map((r) => (j >= 0 && typeof r[j] === "number" ? (r[j] as number) : null));
    }
    const flags = rows.map((r) => (fi >= 0 ? String(r[fi] ?? "OK") : "OK"));
    const ii = sheet.headers.indexOf("Interpolated");
    const interp: number[] = rows.map((r, k) => (ii >= 0 ? (r[ii] === 1 ? 1 : 0) : /Interpolated/.test(flags[k]) ? 1 : 0));
    const stepMin = detectStep(t);
    const flagged = flags.filter((f) => f !== "OK").length;
    const c = (re: RegExp) => flags.filter((f) => re.test(f)).length;
    return {
        ds: { t, cols, flags, stepMin, interp },
        stats: {
            files: 1, rowsRead: rows.length, noDate: 0, duplicates: 0, outsidePeriod: 0, rows: rows.length,
            mapped: Object.keys(cols).length, columns: sheet.headers.length,
            replacedRows: c(/Replaced value/), exceedRows: c(/Exceedance/), missingRows: c(/Missing data/), deadRows: c(/Dead/), abruptRows: c(/Abrupt/), interpolatedRows: interp.reduce((a, b) => a + b, 0),
            flaggedRows: flagged, stepMin, first: t[0] ?? null, last: t[t.length - 1] ?? null,
        },
    };
}
