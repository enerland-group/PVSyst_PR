//-----------------------------------------------------------------------
// SCADA import: what the "MeteoData_InternalAnalysis" Power Query did.
//  1. keep and rename the mapped columns
//  2. drop rows without a timestamp, remove duplicate timestamps
//  3. irradiance below the minimum → 0
//  4. sort by date, keep the test period
//  5. Problematic_Flag: Missing data / Replaced value / Exceedance of limit
//     values (+ optional Dead / Abrupt change, as in Plaza)
//-----------------------------------------------------------------------

import { mappedSensors } from "./params";
import { isoToMin, rowTimes } from "./parse";
import type { Dataset, ModelConfig, RawTable } from "./types";

export interface ImportStats {
    files: number;
    rowsRead: number;
    noDate: number;
    duplicates: number;
    outsidePeriod: number;
    rows: number;
    mapped: number;
    columns: number;
    replacedRows: number;
    exceedRows: number;
    missingRows: number;
    deadRows: number;
    abruptRows: number;
    interpolatedRows: number;
    flaggedRows: number;
    stepMin: number;
    first: number | null;
    last: number | null;
}

export function detectStep(t: number[]): number {
    const counts = new Map<number, number>();
    for (let i = 1; i < Math.min(t.length, 2000); i++) {
        const d = t[i] - t[i - 1];
        if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    let best = 60, n = -1;
    counts.forEach((c, d) => { if (c > n) { n = c; best = d; } });
    return best;
}

export function buildDataset(raw: RawTable, cfg: ModelConfig): { ds: Dataset; stats: ImportStats } {
    const sensors = mappedSensors(cfg.mapping);
    const idx = sensors.map((s) => raw.headers.indexOf(s.raw));
    const dateIdx = (() => {
        const m = cfg.mapping.find((x) => x.param === "DATE");
        const i = m ? raw.headers.indexOf(m.raw) : -1;
        return i >= 0 ? i : raw.dateCol;
    })();

    let noDate = 0, duplicates = 0, outsidePeriod = 0;
    const start = cfg.periodStart ? isoToMin(cfg.periodStart) : -Infinity;
    // End date is inclusive of the whole day; the 00:00 stamp of the next day closes it (end-of-interval data).
    const end = cfg.periodEnd ? isoToMin(cfg.periodEnd) + 1440 : Infinity;

    type Row = { t: number; v: (number | null)[] };
    const seen = new Set<number>();
    const rows: Row[] = [];
    const times = rowTimes(raw, dateIdx);
    for (let ri = 0; ri < raw.rows.length; ri++) {
        const r = raw.rows[ri];
        const t = times[ri];
        if (typeof t !== "number") { noDate++; continue; }
        if (seen.has(t)) { duplicates++; continue; }
        seen.add(t);
        // End-of-interval timestamps: 00:00 of the first day closes the previous day.
        if (t <= start || t > end) { outsidePeriod++; continue; }
        rows.push({ t, v: idx.map((i) => { const x = i >= 0 ? r[i] : null; return typeof x === "number" ? x : null; }) });
    }
    rows.sort((a, b) => a.t - b.t);

    const { qc } = cfg;
    const isIrr = sensors.map((s) => s.param === "GHI" || s.param === "POA" || s.param === "DHI" || s.param === "REF");
    const isTemp = sensors.map((s) => s.param === "T_AMB");

    // 3. irradiance below the minimum → 0
    for (const r of rows) r.v.forEach((x, j) => { if (isIrr[j] && x !== null && x < qc.irrMin) r.v[j] = 0; });

    // 3b. optional: fill short gaps (≤ interpMaxGap consecutive missing values) by linear interpolation
    const interpCell = rows.map(() => new Set<number>());
    const meteo = sensors.map((s) => ["GHI", "POA", "DHI", "REF", "T_AMB", "T_MOD"].includes(s.param));
    if (qc.interpMaxGap > 0) {
        sensors.forEach((_, j) => {
            if (!meteo[j]) return;
            let i = 0;
            while (i < rows.length) {
                if (rows[i].v[j] !== null) { i++; continue; }
                let k = i;
                while (k < rows.length && rows[k].v[j] === null) k++;
                const len = k - i;
                if (i > 0 && k < rows.length && len <= qc.interpMaxGap) {
                    const a = rows[i - 1].v[j] as number, b = rows[k].v[j] as number;
                    const ta = rows[i - 1].t, tb = rows[k].t;
                    for (let m = i; m < k; m++) { rows[m].v[j] = a + ((b - a) * (rows[m].t - ta)) / (tb - ta); interpCell[m].add(j); }
                }
                i = k;
            }
        });
    }

    const t = rows.map((r) => r.t);
    const stepMin = detectStep(t);
    const cols: Dataset["cols"] = {};
    sensors.forEach((s, j) => (cols[s.name] = rows.map((r) => r.v[j])));

    let replacedRows = 0, exceedRows = 0, missingRows = 0, deadRows = 0, abruptRows = 0, flaggedRows = 0, interpolatedRows = 0;
    const flags = rows.map((r, i) => {
        const reasons: string[] = [];
        let rep = false, exc = false, mis = false, dead = false, abr = false;
        interpCell[i].forEach((j) => reasons.push(`Interpolated (${sensors[j].name})`));
        if (interpCell[i].size) interpolatedRows++;
        sensors.forEach((s, j) => {
            if (!isIrr[j] && !isTemp[j]) return;
            const v = r.v[j];
            if (v === null) { reasons.push(`Missing data (${s.name})`); mis = true; return; }
            if (isIrr[j]) {
                if (v === 0) { reasons.push(`Replaced value (${s.name})`); rep = true; }
                if (v > qc.irrMax) { reasons.push(`Exceedance of limit values (${s.name})`); exc = true; }
            } else if (v < qc.tMin || v > qc.tMax) { reasons.push(`Exceedance of limit values (${s.name})`); exc = true; }
            if (qc.deadAbrupt && i > 0) {
                const p = rows[i - 1].v[j];
                const dtSec = (r.t - rows[i - 1].t) * 60;
                if (p !== null && dtSec > 0) {
                    const der = Math.abs(v - p) / dtSec;
                    if (der < qc.deadDeriv && v > qc.deadMinValue) { reasons.push(`Dead (${s.name})`); dead = true; }
                    if (der > (isIrr[j] ? qc.abruptIrr : qc.abruptT)) { reasons.push(`Abrupt change (${s.name})`); abr = true; }
                }
            }
        });
        if (rep) replacedRows++;
        if (exc) exceedRows++;
        if (mis) missingRows++;
        if (dead) deadRows++;
        if (abr) abruptRows++;
        if (reasons.length) flaggedRows++;
        return reasons.length ? Array.from(new Set(reasons)).join("; ") : "OK";
    });

    return {
        ds: { t, cols, flags, stepMin, interp: interpCell.map((c) => (c.size ? 1 : 0)) },
        stats: {
            files: raw.fileNames.length,
            rowsRead: raw.rows.length,
            noDate, duplicates, outsidePeriod,
            rows: rows.length,
            mapped: sensors.length,
            columns: raw.headers.length,
            replacedRows, exceedRows, missingRows, deadRows, abruptRows, flaggedRows, interpolatedRows,
            stepMin,
            first: t.length ? t[0] : null,
            last: t.length ? t[t.length - 1] : null,
        },
    };
}
