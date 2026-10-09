//-----------------------------------------------------------------------
// Column plan for the data sheet (03) — single source of truth.
// Each column carries (a) its values, computed here in TypeScript, and
// (b) the Excel formula that reproduces them in the workbook. Keeping both
// side by side is what lets us test the formulas against the engine.
//-----------------------------------------------------------------------

import { PARAMS, mappedSensors, sensorsOf } from "./params";
import { tr } from "./i18n";
import { isoDateTimeToMin } from "./parse";
import type { Criterion, Dataset, ModelConfig, ParamId, Val } from "./types";

export type ColKind = "value" | "formula" | "internal" | "manual";
export type ColGroup = "time" | "data" | "filter" | "crit" | "result";

export interface Col {
    id: string;
    header: string;
    kind: ColKind;
    group: ColGroup;
    values: Val[];
    /** Formula for Excel row r (data starts at row 2). Without leading "=". */
    f?: (r: number) => string;
    numFmt?: string;
    width?: number;
    note?: string;
}

export interface Input {
    name: string;
    label: string;
    value: number | number[];
    unit: string;
    group: string;
    note?: string;
}

export const isNum = (v: Val): v is number => typeof v === "number" && Number.isFinite(v);
export function average(vals: Val[]): Val {
    const n = vals.filter(isNum);
    return n.length ? n.reduce((a, b) => a + b, 0) / n.length : "";
}
/** Excel QUARTILE / QUARTILE.INC */
export function quartileInc(vals: number[], q: number): number {
    const s = [...vals].sort((a, b) => a - b);
    const pos = (s.length - 1) * (q / 4);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// ── Column letters ────────────────────────────────────────────────────
export function colLetter(i: number): string {
    let s = "";
    let n = i + 1;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
}
export const q = (sheet: string) => `'${sheet.replace(/'/g, "''")}'`;

export class ColumnSheet {
    cols: Col[] = [];
    private idx = new Map<string, number>();
    constructor(public name: string, public n: number) {}
    add(c: Col): Col {
        if (this.idx.has(c.id)) throw new Error(`Duplicate column ${c.id}`);
        this.idx.set(c.id, this.cols.length);
        this.cols.push(c);
        return c;
    }
    has(id: string) { return this.idx.has(id); }
    get(id: string): Col {
        const i = this.idx.get(id);
        if (i === undefined) throw new Error(`Unknown column ${id}`);
        return this.cols[i];
    }
    L(id: string): string {
        const i = this.idx.get(id);
        if (i === undefined) throw new Error(`Unknown column ${id}`);
        return colLetter(i);
    }
    /** Cell reference in the same row */
    c(id: string, r: number) { return `${this.L(id)}${r}`; }
    /** Absolute data range on this sheet (local) */
    range(id: string) { const l = this.L(id); return `$${l}$2:$${l}$${this.n + 1}`; }
    /** Absolute data range qualified with the sheet name (for other sheets) */
    xr(id: string) { return `${q(this.name)}!${this.range(id)}`; }
    /** Single cell qualified with the sheet name */
    xc(id: string, r: number) { return `${q(this.name)}!${this.L(id)}${r}`; }
    /** Horizontal range in one row between two columns */
    hr(a: string, b: string, r: number) { return `${this.L(a)}${r}:${this.L(b)}${r}`; }
}

// ── Inputs ────────────────────────────────────────────────────────────
export interface Plan {
    cfg: ModelConfig;
    ds: Dataset;
    sheet: ColumnSheet;
    inputs: Input[];
    I: Record<string, number>;
    /** column id of the final value per parameter (e.g. "GHI_Average 1") */
    final: Partial<Record<ParamId | "ALB", string>>;
    criteriaCols: string[];
    comply: string;
    /** Total aggregated hours before the aggregated-hours criterion (named cell Agg_Valid_Hours), if used. */
    aggHelper?: string;
    /** Manual event columns whose intervals keep counting but get measured = expected (EPI). */
    eventCols: string[];
    /** Interpolated flag column (when gap filling is on). */
    interpCol?: string;
    aggValidHours?: number;
    /** E_net column for PR (and EPI when the meter is in the SCADA file) */
    eNet?: string;
    stepH: number;
}

const pct = (x: number) => x;

function roundsName(p: ParamId, k: number, what: "pct" | "abs") { return `Rnd${k}_${what === "pct" ? "Pct" : "Abs"}_${p}`; }

export function bucketMin(cfg: ModelConfig, stepMin: number) {
    return cfg.type === "EPI" && cfg.epi.aggregateByHour ? 60 : stepMin;
}

export function buildPlan(cfg: ModelConfig, ds: Dataset): Plan {
    const L = tr(cfg.project.lang);
    const n = ds.t.length;
    const sh = new ColumnSheet(cfg.type === "EPI" ? L.sData : L.sDataPR, n);
    const inputs: Input[] = [];
    const I: Record<string, number> = {};
    const addIn = (name: string, label: string, value: number, unit: string, group: string, note?: string) => {
        if (I[name] !== undefined) return;
        I[name] = value;
        inputs.push({ name, label, value, unit, group, note });
    };
    const stepH = ds.stepMin / 60;
    addIn("Step_h", "Interval length of the SCADA data", stepH, "h", "Data");
    const rows = Array.from({ length: n }, (_, i) => i);

    // Time and helpers -------------------------------------------------------
    sh.add({ id: "Date", header: "Date", kind: "value", group: "time", values: ds.t.map((m) => m / 1440), numFmt: "dd/mm/yyyy hh:mm", width: 17 });
    const day = ds.t.map((m) => Math.floor(m / 1440));
    sh.add({ id: "Day", header: "Day", kind: "formula", group: "time", values: day, f: (r) => `INT(${sh.c("Date", r)})`, numFmt: "dd/mm/yyyy", width: 11 });
    if (cfg.type === "EPI") {
        const hourly = cfg.epi.aggregateByHour;
        sh.add({
            id: "Key", header: hourly ? "Hour key" : "Interval key", kind: "formula", group: "time",
            values: ds.t.map((m) => (hourly ? Math.floor((m - 1) / 60) : m)),
            f: (r) => (hourly ? `INT(ROUND((${sh.c("Date", r)}*1440-1)/60,6))` : `ROUND(${sh.c("Date", r)}*1440,0)`),
            numFmt: "0", width: 10,
            note: hourly ? "Hour index used to join with PVsyst and the meter (end-of-interval stamps: 10:15…11:00 → 10:00)." : "Minute index used to join with PVsyst and the meter.",
        });
    }

    // Raw sensors --------------------------------------------------------------
    const sensors = mappedSensors(cfg.mapping);
    for (const s of sensors) {
        sh.add({ id: s.name, header: s.name, kind: "value", group: "data", values: ds.cols[s.name] ?? new Array(n).fill(null), numFmt: "0.00", width: 13 });
    }

    let interpCol: string | undefined;
    if (cfg.qc.interpMaxGap > 0) {
        interpCol = "Interpolated";
        sh.add({ id: interpCol, header: "Interpolated", kind: "value", group: "data", values: ds.interp, numFmt: "0", width: 9, note: `1 = at least one meteo value of the interval was filled by linear interpolation (gaps ≤ ${cfg.qc.interpMaxGap} intervals)` });
    }

    // Sensor aggregation per parameter ------------------------------------------
    const final: Plan["final"] = {};
    addIn("IQR_k", "IQR multiplier for outliers", cfg.iqrK, "-", "Filtering");
    for (const p of PARAMS) {
        const ss = sensorsOf(cfg.mapping, p.id);
        if (!ss.length) continue;
        if (ss.length === 1 || !p.filterable) { final[p.id] = ss[0].name; continue; }
        const fc = cfg.filters[p.id] ?? { method: "NONE", dailyTol: 0.05, dailyTwoSided: true, rounds: [] };
        let stage = ss.map((s) => s.name); // ids of the current per-sensor stage
        const first = stage[0], last = stage[stage.length - 1];

        if (fc.method === "IQR" && ss.length >= 3) {
            stage = ss.map((s, k) => {
                const id = `${p.id} ${String(k + 1).padStart(2, "0")} Filtered`;
                sh.add({
                    id, header: id, kind: "formula", group: "filter", numFmt: "0.00", width: 12,
                    values: rows.map((i) => {
                        const x = sh.get(s.name).values[i];
                        if (!isNum(x)) return "";
                        const all = ss.map((z) => sh.get(z.name).values[i]).filter(isNum);
                        if (all.length < 3) return x;
                        const q1 = quartileInc(all, 1), q3 = quartileInc(all, 3), iqr = q3 - q1;
                        return x < q1 - cfg.iqrK * iqr || x > q3 + cfg.iqrK * iqr ? "Outlier" : x;
                    }),
                    f: (r) => {
                        const x = sh.c(s.name, r), rg = sh.hr(first, last, r);
                        const q1 = `QUARTILE(${rg},1)`, q3 = `QUARTILE(${rg},3)`;
                        return `IF(ISNUMBER(${x}),IF(COUNT(${rg})<3,${x},IF(OR(${x}<${q1}-IQR_k*(${q3}-${q1}),${x}>${q3}+IQR_k*(${q3}-${q1})),"Outlier",${x})),"")`;
                    },
                });
                return id;
            });
        } else if (fc.method === "DAILY_MEAN") {
            const tolName = `Daily_Tol_${p.id}`;
            addIn(tolName, `${p.id}: daily-mean deviation tolerance`, pct(fc.dailyTol), "fraction", "Filtering");
            const byDay = new Map<number, number[]>();
            day.forEach((d, i) => { if (!byDay.has(d)) byDay.set(d, []); byDay.get(d)!.push(i); });
            const meanIds = ss.map((s, k) => {
                const id = `${p.id} ${String(k + 1).padStart(2, "0")} Daily mean`;
                const dayMean = new Map<number, Val>();
                byDay.forEach((idx, d) => dayMean.set(d, average(idx.map((i) => sh.get(s.name).values[i]))));
                sh.add({
                    id, header: id, kind: "formula", group: "filter", numFmt: "0.00", width: 12,
                    values: rows.map((i) => dayMean.get(day[i]) ?? ""),
                    f: (r) => `IFERROR(AVERAGEIFS(${sh.range(s.name)},${sh.range("Day")},${sh.c("Day", r)}),"")`,
                });
                return id;
            });
            const m0 = meanIds[0], m1 = meanIds[meanIds.length - 1];
            stage = ss.map((s, k) => {
                const id = `${p.id} ${String(k + 1).padStart(2, "0")} Filtered`;
                sh.add({
                    id, header: id, kind: "formula", group: "filter", numFmt: "0.00", width: 12,
                    values: rows.map((i) => {
                        const x = sh.get(s.name).values[i];
                        if (!isNum(x)) return "";
                        const mk = sh.get(meanIds[k]).values[i];
                        const avg = average(meanIds.map((mid) => sh.get(mid).values[i]));
                        if (!isNum(mk) || !isNum(avg) || avg === 0) return x;
                        const dev = (mk - avg) / avg;
                        return (fc.dailyTwoSided ? Math.abs(dev) : dev) > fc.dailyTol ? "Discard" : x;
                    }),
                    f: (r) => {
                        const x = sh.c(s.name, r), mk = sh.c(meanIds[k], r), avg = `AVERAGE(${sh.hr(m0, m1, r)})`;
                        const dev = `(${mk}-${avg})/${avg}`;
                        return `IF(ISNUMBER(${x}),IFERROR(IF(${fc.dailyTwoSided ? `ABS(${dev})` : dev}>${tolName},"Discard",${x}),${x}),"")`;
                    },
                });
                return id;
            });
        }

        const avgId = `${p.id}_Average Filtered`;
        const st0 = [...stage];
        sh.add({
            id: avgId, header: avgId, kind: "formula", group: "filter", numFmt: "0.00", width: 13,
            values: rows.map((i) => average(st0.map((id) => sh.get(id).values[i]))),
            f: (r) => `IFERROR(AVERAGE(${sh.hr(st0[0], st0[st0.length - 1], r)}),"")`,
        });
        let prevAvg = avgId;
        fc.rounds.forEach((rd, k0) => {
            const k = k0 + 1;
            const pn = roundsName(p.id, k, "pct"), an = roundsName(p.id, k, "abs");
            addIn(pn, `${p.id}: round ${k} relative tolerance`, rd.pct, "fraction", "Filtering");
            addIn(an, `${p.id}: round ${k} absolute tolerance`, rd.abs, p.unit, "Filtering");
            const pa = prevAvg, prevStage = [...stage];
            stage = ss.map((_, j) => {
                const id = `${p.id} ${String(j + 1).padStart(2, "0")} Rnd${k}`;
                sh.add({
                    id, header: id, kind: "formula", group: "filter", numFmt: "0.00", width: 12,
                    values: rows.map((i) => {
                        const par = sh.get(prevStage[j]).values[i], avg = sh.get(pa).values[i];
                        if (!isNum(par) || !isNum(avg)) return "";
                        const ad = Math.abs(par - avg);
                        if (avg === 0) return ad > rd.abs ? "Discard" : par;
                        return Math.abs(ad / avg) > rd.pct && ad > rd.abs ? "Discard" : par;
                    }),
                    f: (r) => {
                        const par = sh.c(prevStage[j], r), avg = sh.c(pa, r);
                        return `IF(AND(ISNUMBER(${par}),ISNUMBER(${avg})),IF(${avg}=0,IF(ABS(${par}-${avg})>${an},"Discard",${par}),IF(AND(ABS((${par}-${avg})/${avg})>${pn},ABS(${par}-${avg})>${an}),"Discard",${par})),"")`;
                    },
                });
                return id;
            });
            const aid = `${p.id}_Average ${k}`;
            const stk = [...stage];
            sh.add({
                id: aid, header: aid, kind: "formula", group: "filter", numFmt: "0.00", width: 13,
                values: rows.map((i) => average(stk.map((id) => sh.get(id).values[i]))),
                f: (r) => `IFERROR(AVERAGE(${sh.hr(stk[0], stk[stk.length - 1], r)}),"")`,
            });
            prevAvg = aid;
        });
        final[p.id] = prevAvg;
    }

    // Albedo ---------------------------------------------------------------------
    const short2name = new Map(sensors.map((s) => [s.short, s.name]));
    const albIds: string[] = [];
    cfg.albedo.forEach((pair, k) => {
        const ref = short2name.get(pair.ref), glob = short2name.get(pair.glob);
        if (!ref || !glob) return;
        const id = `ALB ${String(k + 1).padStart(2, "0")}`;
        sh.add({
            id, header: id, kind: "formula", group: "filter", numFmt: "0.0000", width: 9,
            note: `${pair.ref} / ${pair.glob}`,
            values: rows.map((i) => {
                const rv = sh.get(ref).values[i], gv = sh.get(glob).values[i];
                if (!isNum(rv) || !isNum(gv)) return "";
                return gv === 0 ? 0 : Math.max(0, rv / gv);
            }),
            f: (r) => { const a = sh.c(ref, r), b = sh.c(glob, r); return `IF(AND(ISNUMBER(${a}),ISNUMBER(${b})),IF(${b}=0,0,MAX(0,${a}/${b})),"")`; },
        });
        albIds.push(id);
    });
    if (albIds.length === 1) final.ALB = albIds[0];
    if (albIds.length > 1) {
        const id = "ALB_Average Filtered";
        sh.add({
            id, header: id, kind: "formula", group: "filter", numFmt: "0.0000", width: 13,
            values: rows.map((i) => average(albIds.map((a) => sh.get(a).values[i]))),
            f: (r) => `IFERROR(AVERAGE(${sh.hr(albIds[0], albIds[albIds.length - 1], r)}),"")`,
        });
        final.ALB = id;
    }

    // Meter in the SCADA file (PR, or EPI with meter source "scada") ------------
    let eNet: string | undefined;
    const prod = sensorsOf(cfg.mapping, "E_GRID")[0], cons = sensorsOf(cfg.mapping, "E_IMP")[0];
    if ((cfg.type === "PR" || cfg.meter.source === "scada") && prod) {
        addIn("Step_h", "Interval length", stepH, "h", "Data");
        const unit = cfg.meter.unit, useCons = cfg.meter.mode === "two" && !!cons;
        eNet = "E_net (kW)";
        const pv = sh.get(prod.name).values, cv = useCons ? sh.get(cons!.name).values : null;
        const netRaw = (i: number): Val => {
            const a = pv[i];
            if (!isNum(a)) return "";
            if (cfg.meter.mode === "prod" || !cv) return a;
            const b = cv[i];
            return a - Math.abs(isNum(b) ? b : 0);
        };
        sh.add({
            id: eNet, header: eNet, kind: "formula", group: "filter", numFmt: "0.00", width: 12,
            note: unit === "power" ? "Average power of the interval" : unit === "energy" ? "Interval energy ÷ interval length" : "Counter difference ÷ interval length",
            values: rows.map((i) => {
                if (unit === "counter") {
                    if (i === 0) return "";
                    const a = netRaw(i), b = netRaw(i - 1);
                    return isNum(a) && isNum(b) ? (a - b) / stepH : "";
                }
                const v = netRaw(i);
                return isNum(v) ? (unit === "energy" ? v / stepH : v) : "";
            }),
            f: (r) => {
                const net = (rr: number) => {
                    const a = sh.c(prod.name, rr);
                    if (cfg.meter.mode === "prod" || !useCons) return a;
                    return `(${a}-ABS(N(${sh.c(cons!.name, rr)})))`;
                };
                const a = sh.c(prod.name, r);
                if (unit === "counter") return r === 2 ? `""` : `IF(AND(ISNUMBER(${a}),ISNUMBER(${sh.c(prod.name, r - 1)})),(${net(r)}-${net(r - 1)})/Step_h,"")`;
                return `IF(ISNUMBER(${a}),${net(r)}${unit === "energy" ? "/Step_h" : ""},"")`;
            },
        });
    }

    // Criteria ------------------------------------------------------------------
    const criteriaCols: string[] = [];
    let cn = 0;
    const nextId = () => `C${String(++cn).padStart(2, "0")}`;
    const thr = cfg.thr;
    let aggHelper: string | undefined;
    let aggValidHours: number | undefined;

    const addCrit = (c: Criterion, label: string, values: Val[], f: (r: number) => string, kind: ColKind = "formula") => {
        const id = nextId();
        sh.add({ id, header: `${id} · ${label}`, kind, group: "crit", values, f: kind === "manual" ? undefined : f, numFmt: "0", width: 10, note: c.label });
        criteriaCols.push(id);
        return id;
    };
    const fin = (p: ParamId | "ALB") => final[p];
    const eventCols: string[] = [];
    const ensureAbove = (): string | undefined => {
        const col = fin("POA");
        if (!col) return undefined;
        const id = "Above seasonal threshold";
        addIn("Summer_Start", "First month of the summer period", thr.summerStart, "month", "Criteria");
        addIn("Summer_End", "Last month of the summer period", thr.summerEnd, "month", "Criteria");
        addIn("POA_Thr_Summer", "POA threshold in summer months", thr.poaThrSummer, "W/m²", "Criteria");
        addIn("POA_Thr_Winter", "POA threshold in the other months", thr.poaThrWinter, "W/m²", "Criteria");
        if (sh.has(id)) return id;
        const above = rows.map((i) => {
            const v = sh.get(col).values[i];
            const mo = new Date((ds.t[i] / 1440 - 25569) * 86400000).getUTCMonth() + 1;
            const thrV = mo >= thr.summerStart && mo <= thr.summerEnd ? thr.poaThrSummer : thr.poaThrWinter;
            return isNum(v) && v >= thrV ? 1 : 0;
        });
        sh.add({
            id, header: id, kind: "formula", group: "crit", values: above, numFmt: "0", width: 10,
            f: (r) => { const v = sh.c(col, r), m = `MONTH(${sh.c("Date", r)})`; return `IF(ISNUMBER(${v}),IF(${v}>=IF(AND(${m}>=Summer_Start,${m}<=Summer_End),POA_Thr_Summer,POA_Thr_Winter),1,0),0)`; },
        });
        return id;
    };

    for (const c of cfg.criteria) {
        if (!c.on) continue;
        switch (c.type) {
            case "available": {
                for (const p of c.params ?? []) {
                    const col = fin(p);
                    if (!col) continue;
                    addCrit(c, `${p} available`, rows.map((i) => (isNum(sh.get(col).values[i]) ? 1 : 0)), (r) => `IF(ISNUMBER(${sh.c(col, r)}),1,0)`);
                }
                break;
            }
            case "poaFloor": {
                const col = fin("POA");
                if (!col) break;
                addIn("POA_Floor", "Minimum POA irradiance per interval", thr.poaFloor, "W/m²", "Criteria");
                addCrit(c, "POA ≥ floor", rows.map((i) => { const v = sh.get(col).values[i]; return isNum(v) && v >= thr.poaFloor ? 1 : 0; }),
                    (r) => `IF(ISNUMBER(${sh.c(col, r)}),IF(${sh.c(col, r)}>=POA_Floor,1,0),0)`);
                break;
            }
            case "seasonalHours": {
                const aboveId = ensureAbove();
                if (!aboveId) break;
                addIn("Min_Hours_Day", "Minimum hours above the threshold per day", thr.minHoursDay, "h", "Criteria");
                const above = sh.get(aboveId).values as number[];
                const hoursByDay = new Map<number, number>();
                rows.forEach((i) => { if (above[i] === 1) hoursByDay.set(day[i], (hoursByDay.get(day[i]) ?? 0) + 1); });
                addCrit(c, "hours above threshold", rows.map((i) => ((hoursByDay.get(day[i]) ?? 0) * stepH >= thr.minHoursDay ? 1 : 0)),
                    (r) => `IF(COUNTIFS(${sh.range("Day")},${sh.c("Day", r)},${sh.range("Above seasonal threshold")},1)*Step_h>=Min_Hours_Day,1,0)`);
                break;
            }
            case "aggHours": {
                addIn("Min_Hours_Test", "Minimum aggregated valid hours over the test", thr.minHoursTest, "h", "Criteria");
                addIn("Step_h", "Interval length", stepH, "h", "Data");
                const prev = [...criteriaCols];
                const aboveId = c.aboveSeasonal ? ensureAbove() : undefined;
                if (aboveId) prev.push(aboveId);
                aggHelper = "Valid before aggregated hours";
                const hv = rows.map((i) => prev.reduce((a, id) => a * (sh.get(id).values[i] as number), 1));
                sh.add({
                    id: aggHelper, header: aggHelper, kind: "formula", group: "crit", values: hv, numFmt: "0", width: 10,
                    note: aboveId ? "Valid intervals above the seasonal POA threshold. The sum × Step_h gives Agg_Valid_Hours (00 Summary)." : "Product of the criteria to the left. The sum × Step_h gives Agg_Valid_Hours (00 Summary).",
                    f: (r) => (prev.length ? prev.map((id) => sh.c(id, r)).join("*") : "1"),
                });
                aggValidHours = hv.reduce((a: number, b) => a + (b as number), 0) * stepH;
                const ok = aggValidHours >= thr.minHoursTest ? 1 : 0;
                addCrit(c, "aggregated hours", rows.map(() => ok), () => `IF(Agg_Valid_Hours>=Min_Hours_Test,1,0)`);
                break;
            }
            case "curtailment": {
                const sp = sensorsOf(cfg.mapping, "SETPOINT")[0];
                const was = c.windAlarm ? sensorsOf(cfg.mapping, "WA") : [];
                const pf = c.pf ? sensorsOf(cfg.mapping, "PF")[0] : undefined;
                if (!sp && !was.length && !pf) break;
                if (sp) addIn("POI_kW", "POI power without limitation (setpoint below it = curtailment)", thr.poiKw, "kW", "Criteria");
                if (pf) { addIn("PF_Min", "Minimum power factor", thr.pfMin, "-", "Criteria"); addIn("PF_Max", "Maximum power factor", thr.pfMax, "-", "Criteria"); }
                addCrit(c, "no curtailment / stow / PF", rows.map((i) => {
                    if (sp) { const v = sh.get(sp.name).values[i]; if (!isNum(v) || v < thr.poiKw) return 0; }
                    for (const w of was) if (sh.get(w.name).values[i] === 1) return 0;
                    if (pf) { const v = sh.get(pf.name).values[i]; if (!isNum(v) || v < thr.pfMin || v > thr.pfMax) return 0; }
                    return 1;
                }), (r) => {
                    const parts: string[] = [];
                    if (sp) { const v = sh.c(sp.name, r); parts.push(`NOT(ISNUMBER(${v}))`, `N(${v})<POI_kW`); }
                    for (const w of was) parts.push(`N(${sh.c(w.name, r)})=1`);
                    if (pf) { const v = sh.c(pf.name, r); parts.push(`NOT(ISNUMBER(${v}))`, `N(${v})<PF_Min`, `N(${v})>PF_Max`); }
                    return `IF(OR(${parts.join(",")}),0,1)`;
                });
                break;
            }
            case "noMissing": {
                const ss = (c.params ?? []).filter((p): p is ParamId => p !== "ALB").flatMap((p) => sensorsOf(cfg.mapping, p));
                if (!ss.length) break;
                const floorCol = criteriaCols.find((id) => sh.get(id).header.includes("POA ≥ floor"));
                addCrit(c, "no missing data", rows.map((i) => {
                    if (c.exceptWhenFloorFails && floorCol && sh.get(floorCol).values[i] === 0) return 1;
                    return ss.every((s) => isNum(sh.get(s.name).values[i])) ? 1 : 0;
                }), (r) => {
                    const cnt = ss.map((s) => `ISNUMBER(${sh.c(s.name, r)})`).join(",");
                    const all = `AND(${cnt})`;
                    return c.exceptWhenFloorFails && floorCol ? `IF(OR(${all},${sh.c(floorCol, r)}=0),1,0)` : `IF(${all},1,0)`;
                });
                break;
            }
            case "exporting": {
                if (!eNet) break;
                const e = eNet;
                const poaCol = fin("POA");
                if (c.dayLevel && poaCol) {
                    addIn("POA_Floor", "Minimum POA irradiance per interval", thr.poaFloor, "W/m²", "Criteria");
                    const bad = new Set<number>();
                    rows.forEach((i) => { const g = sh.get(poaCol).values[i], v = sh.get(e).values[i]; if (isNum(g) && g >= thr.poaFloor && isNum(v) && v <= 0) bad.add(day[i]); });
                    addCrit(c, "available all day", rows.map((i) => (bad.has(day[i]) ? 0 : 1)),
                        (r) => `IF(COUNTIFS(${sh.range("Day")},${sh.c("Day", r)},${sh.range(poaCol)},">="&POA_Floor,${sh.range(e)},"<=0")=0,1,0)`);
                } else {
                    addCrit(c, "plant exporting", rows.map((i) => { const v = sh.get(e).values[i]; return isNum(v) && v > 0 ? 1 : 0; }),
                        (r) => `IF(N(${sh.c(e, r)})>0,1,0)`);
                }
                break;
            }
            case "setpointMin": {
                const sp = sensorsOf(cfg.mapping, "SETPOINT")[0];
                if (!sp) break;
                addIn("Setpoint_Min", "Minimum PPC setpoint (no curtailment)", thr.setpointMin, "kW", "Criteria");
                addCrit(c, "setpoint ≥ minimum", rows.map((i) => { const v = sh.get(sp.name).values[i]; return isNum(v) && v >= thr.setpointMin ? 1 : 0; }),
                    (r) => `IF(N(${sh.c(sp.name, r)})>=Setpoint_Min,1,0)`);
                break;
            }
            case "manual": {
                if (c.replaceWithExpected && cfg.type === "EPI") {
                    const id = `Event ${String(eventCols.length + 1).padStart(2, "0")}`;
                    sh.add({ id, header: `${id} · ${c.label || "external event"}`, kind: "manual", group: "crit", values: rows.map(() => 1), numFmt: "0", width: 11, note: `${c.label} — set 0 where an external event applies: the measured energy of that step is replaced by the expected energy.` });
                    eventCols.push(id);
                } else addCrit(c, c.label || "manual", rows.map(() => 1), () => "", "manual");
                break;
            }
            case "threshold": {
                const p = c.param ?? "POA";
                const col = fin(p);
                if (!col) break;
                const name = `Thr_${c.id.replace(/[^A-Za-z0-9_]/g, "_")}`;
                const v0 = c.value ?? 0, op = c.op ?? ">=";
                addIn(name, `${p} ${op} threshold (${c.label})`, v0, p === "ALB" ? "-" : "W/m²", "Criteria");
                addCrit(c, `${p} ${op} ${v0}`, rows.map((i) => { const v = sh.get(col).values[i]; return isNum(v) && (op === ">" ? v > v0 : v >= v0) ? 1 : 0; }),
                    (r) => `IF(ISNUMBER(${sh.c(col, r)}),IF(${sh.c(col, r)}${op}${name},1,0),0)`);
                break;
            }
        }
    }

    // Periods excluded by hand: always present, so periods can also be added later in Excel (08 Exclusions)
    {
        const per = exclusionPeriods(cfg);
        const id = nextId();
        sh.add({
            id, header: `${id} · not in an excluded period`, kind: "formula", group: "crit", numFmt: "0", width: 10,
            note: "0 when the interval falls in a period of the Exclusions table (From < Date ≤ To)",
            values: rows.map((i) => (per.some((p) => p.a < ds.t[i] && ds.t[i] <= p.b) ? 0 : 1)),
            f: (r) => `IF(COUNTIFS(Excl_From,"<"&(${sh.c("Date", r)}-0.000001),Excl_To,">="&(${sh.c("Date", r)}-0.000001))>0,0,1)`,
        });
        criteriaCols.push(id);
    }

    const comply = "Comply with all criteria?";
    sh.add({
        id: comply, header: comply, kind: "formula", group: "result", numFmt: "0", width: 11,
        values: rows.map((i) => criteriaCols.reduce((a, id) => a * (sh.get(id).values[i] as number), 1)),
        f: (r) => (criteriaCols.length ? criteriaCols.map((id) => sh.c(id, r)).join("*") : "1"),
    });

    // PR columns ------------------------------------------------------------------
    if (cfg.type === "PR") {
        const pr = cfg.pr;
        addIn("P_stc", "Peak power at STC", pr.pstcKwp, "kWp", "PR", pr.pstcNote);
        addIn("G_stc", "Irradiance at STC", pr.gstc, "W/m²", "PR");
        addIn("Delta", "Temperature coefficient of power", pr.deltaPctPerC / 100, "1/ºC", "PR", `${pr.deltaPctPerC} %/ºC`);
        addIn("FT", "Tolerance factor", pr.ft, "-", "PR");
        inputs.push({ name: "Tavg_Month", label: "Contractual average cell temperature per month (Jan–Dec)", value: [...pr.tavg], unit: "ºC", group: "PR monthly" });
        inputs.push({ name: "PR_Design_Month", label: "Design PR per month (Jan–Dec)", value: [...pr.prDesign], unit: "-", group: "PR monthly" });
        const tm = fin("T_MOD"), poa = fin("POA");
        if (tm && poa && eNet) {
            sh.add({
                id: "Ck", header: "Ck", kind: "formula", group: "result", numFmt: "0.0000", width: 9,
                values: rows.map((i) => {
                    const t = sh.get(tm).values[i];
                    if (!isNum(t)) return "";
                    const mo = new Date((ds.t[i] / 1440 - 25569) * 86400000).getUTCMonth();
                    return 1 + (pr.deltaPctPerC / 100) * (t - pr.tavg[mo]);
                }),
                f: (r) => `IFERROR(1+Delta*(${sh.c(tm, r)}-INDEX(Tavg_Month,MONTH(${sh.c("Date", r)}))),"")`,
            });
            sh.add({
                id: "PR'_i (kW)", header: "PR'_i (kW)", kind: "formula", group: "result", numFmt: "0.00", width: 12,
                note: "Reference power of the interval: P_stc × Ck × POA / G_stc",
                values: rows.map((i) => {
                    const ck = sh.get("Ck").values[i], g = sh.get(poa).values[i];
                    return isNum(ck) && isNum(g) ? (pr.pstcKwp * ck * g) / pr.gstc : 0;
                }),
                f: (r) => `IFERROR(P_stc*${sh.c("Ck", r)}*${sh.c(poa, r)}/G_stc,0)`,
            });
        }
    }

    // Internal QC flags go last, so the client version can drop the column without shifting any reference.
    sh.add({ id: "Problematic_Flag", header: "Problematic_Flag", kind: "internal", group: "data", values: ds.flags, width: 40 });

    return { cfg, ds, sheet: sh, inputs, I, final, criteriaCols, comply, aggHelper, aggValidHours, eNet, stepH, eventCols, interpCol };
}

/** Valid exclusion periods in minutes (from < t ≤ to). */
export function exclusionPeriods(cfg: ModelConfig): { a: number; b: number }[] {
    return (cfg.days?.excluded ?? []).map((e) => ({ a: isoDateTimeToMin(e.from), b: isoDateTimeToMin(e.to) }))
        .filter((p): p is { a: number; b: number } => p.a !== null && p.b !== null && p.b > p.a);
}
