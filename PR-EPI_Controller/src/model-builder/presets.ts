//-----------------------------------------------------------------------
// Default configurations. EPI follows the Fraga workbook (2026-05),
// PR follows Ensol I (2026-07) with the agreed corrections
// (δ = −0.26 %/ºC, daily irradiation over all intervals ÷ intervals per hour,
// hours counted with POA ≥ 500 W/m²).
//-----------------------------------------------------------------------

import { readTableBuffer, rowTimes } from "./parse";
import { sensorsOf } from "./params";
import type { Criterion, Exclusion, MeterTable, ModelConfig, ParamFilter, ParamId, RawTable, TestType } from "./types";

const f = (method: ParamFilter["method"], rounds: ParamFilter["rounds"] = [], dailyTol = 0.05, dailyTwoSided = true): ParamFilter => ({ method, rounds, dailyTol, dailyTwoSided });

export function defaultCriteria(type: TestType): Criterion[] {
    if (type === "EPI") {
        return [
            { id: "avail", type: "available", on: true, label: "Required parameters have a valid value (GHI, DHI, T_AMB)", params: ["GHI", "DHI", "T_AMB"] },
            { id: "floor", type: "poaFloor", on: true, label: "Discard intervals under the POA floor" },
            { id: "season", type: "seasonalHours", on: false, label: "Day is valid if enough hours exceed the seasonal POA threshold" },
            { id: "agg", type: "aggHours", on: true, label: "The whole test needs a minimum of aggregated valid hours" },
            { id: "curt", type: "curtailment", on: true, label: "Setpoint below the POI limit, wind alarm or PF out of range invalidates the interval", windAlarm: true, pf: true },
            { id: "manual", type: "manual", on: false, label: "Manual exclusion (edit 1 → 0 in the workbook)" },
        ];
    }
    return [
        { id: "floor", type: "poaFloor", on: true, label: "POA at or above the floor" },
        { id: "missing", type: "noMissing", on: true, label: "POA and module temperature recorded (night intervals excepted)", params: ["POA", "T_MOD"], exceptWhenFloorFails: true },
        { id: "export", type: "exporting", on: true, label: "Plant exporting (meter power > 0)" },
        { id: "interp", type: "manual", on: true, label: "Interpolated intervals ≤ 1 % (manual)" },
        { id: "setpoint", type: "setpointMin", on: true, label: "No curtailment: setpoint at or above the minimum" },
        { id: "external", type: "manual", on: false, label: "External events (manual)" },
    ];
}

export function defaultConfig(type: TestType): ModelConfig {
    const base: ModelConfig = {
        version: 1,
        type,
        project: { name: "", code: "", country: "", lang: type === "PR" ? "ES" : "EN", client: "", contractRef: "" },
        periodStart: "",
        periodEnd: "",
        mapping: [],
        filters: {
            GHI: f("IQR", [{ pct: 0.05, abs: 0 }]),
            POA: f(type === "PR" ? "DAILY_MEAN" : "IQR", [], 0.05, true),
            REF: f("NONE"),
            DHI: f("NONE", [{ pct: 0.05, abs: 0 }]),
            T_AMB: f("NONE", [{ pct: 0.1, abs: 5 }]),
            T_MOD: f("NONE"),
        },
        iqrK: 1.5,
        albedo: [],
        qc: { irrMin: 0, irrMax: 1500, tMin: -20, tMax: 50, deadAbrupt: false, deadDeriv: 0.0001, deadMinValue: 5, abruptIrr: 800, abruptT: 4, interpMaxGap: 0 },
        criteria: defaultCriteria(type),
        thr: {
            poaFloor: 100, summerStart: 4, summerEnd: 9, poaThrSummer: 600, poaThrWinter: 400, minHoursDay: 3,
            minHoursTest: 10, poiKw: 0, pfMin: 1, pfMax: 1, setpointMin: 0,
        },
        epi: { guaranteedEpi: 0.98, degradation: 1, availability: 1, timeShiftMin: 0, aggregateByHour: false, passRule: "energy" },
        pr: {
            pstcKwp: 0, pstcNote: "", gstc: 1000, deltaPctPerC: -0.26, ft: 0.97,
            tavg: new Array(12).fill(25), prDesign: new Array(12).fill(0.8),
            overall: "weighted", albedoBase: 0, albedoTol: 0.2,
        },
        days: type === "PR"
            ? { required: 10, maxWindow: 0, fallbackTopK: 0, minHours: 3, hoursPoaThr: 500, minDailyWh: 3000, irrAllIntervals: true, maxInterpPct: 0.01, excluded: [] }
            : { required: 10, maxWindow: 0, fallbackTopK: 0, minHours: 0, hoursPoaThr: 500, minDailyWh: 0, irrAllIntervals: true, maxInterpPct: 0.01, excluded: [] },
        meter: { source: type === "PR" ? "scada" : "file", mode: "two", unit: "power", dateCol: "", prodCol: "", consCol: "" },
    };
    return base;
}

/** Build the meter table from an imported file and the chosen columns. */
export function meterFromTable(raw: RawTable, cfg: ModelConfig): MeterTable {
    const di = cfg.meter.dateCol ? raw.headers.indexOf(cfg.meter.dateCol) : raw.dateCol;
    const pi = raw.headers.indexOf(cfg.meter.prodCol);
    const ci = cfg.meter.mode === "two" ? raw.headers.indexOf(cfg.meter.consCol) : -1;
    if (pi < 0) throw new Error("Choose the meter production column.");
    if (cfg.meter.mode === "two" && ci < 0) throw new Error("Choose the meter consumption column, or switch to 'Single net column' / 'Production only'.");
    const seen = new Set<number>();
    const times = rowTimes(raw, di < 0 ? raw.dateCol : di);
    const rows = raw.rows
        .map((r, i) => ({ t: times[i], p: r[pi], c: ci >= 0 ? r[ci] : null }))
        .filter((r): r is { t: number; p: number | string | null; c: number | string | null } => r.t !== null)
        .filter((r) => (seen.has(r.t) ? false : (seen.add(r.t), true)))
        .sort((a, b) => a.t - b.t);
    const t = rows.map((r) => r.t);
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    let step = 15;
    if (t.length > 1) {
        const counts = new Map<number, number>();
        for (let i = 1; i < Math.min(t.length, 500); i++) counts.set(t[i] - t[i - 1], (counts.get(t[i] - t[i - 1]) ?? 0) + 1);
        step = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
    return { fileNames: raw.fileNames, t, prod: rows.map((r) => num(r.p)), cons: rows.map((r) => num(r.c)), headers: raw.headers, stepMin: step };
}

export function suggestMeterColumns(raw: RawTable): { prod: string; cons: string; date: string } {
    const headers = raw.headers;
    const up = headers.map((h) => h.toUpperCase());
    // Energy carried by each column: an all-zero column is never the production
    const mass = headers.map((_, j) => (j === raw.dateCol ? 0 : raw.rows.reduce((s, r) => s + (typeof r[j] === "number" ? Math.abs(r[j] as number) : 0), 0)));
    const idx = /\b(N[ºO°]?|ID|INDEX|ROW|FILA)\b\.?$/;
    const find = (re: RegExp) => { const i = up.findIndex((h, j) => re.test(h) && mass[j] > 0); return i >= 0 ? headers[i] : ""; };
    const largest = () => {
        let best = -1;
        mass.forEach((m, j) => { if (m > 0 && !idx.test(up[j]) && !isCounterLike(raw, j) && (best < 0 || m > mass[best])) best = j; });
        return best >= 0 ? headers[best] : "";
    };
    const prod = find(/ACTIVE POWER.*\(KW\)|POTENCIA ACTIVA|ACTIVA.*\(KW\)/) || find(/(ACTIVA|ACTIVE|EXPORT|PRODUC)/) || largest();
    return {
        date: raw.dateCol >= 0 ? headers[raw.dateCol] : "",
        prod,
        cons: find(/IMPORT.*\(KW\)/) || find(/IMPORT/) || find(/CONSUM/),
    };
}

/** 1, 2, 3… row numbers (an index column, not a measurement). */
function isCounterLike(raw: RawTable, j: number): boolean {
    const v = raw.rows.slice(0, 50).map((r) => r[j]).filter((x): x is number => typeof x === "number");
    return v.length > 5 && v.every((x, i) => i === 0 || x - v[i - 1] === 1);
}

export { readTableBuffer };

/** Fill fields added after a model was saved (older saved workbooks). */
export function normalizeConfig(c: ModelConfig): ModelConfig {
    const d = defaultConfig(c.type);
    const pr = { ...d.pr, ...c.pr } as ModelConfig["pr"] & Record<string, unknown>;
    // v1 drafts kept the valid-day thresholds inside pr
    const legacy = c.pr as unknown as { dayPoaThr?: number; dayMinHours?: number; dayMinWh?: number; irrAllIntervals?: boolean };
    const days = { ...d.days, ...(c.days ?? {}) };
    if (!c.days && legacy.dayPoaThr !== undefined) {
        days.hoursPoaThr = legacy.dayPoaThr; days.minHours = legacy.dayMinHours ?? days.minHours;
        days.minDailyWh = legacy.dayMinWh ?? days.minDailyWh; days.irrAllIntervals = legacy.irrAllIntervals ?? days.irrAllIntervals;
    }
    for (const k of ["dayPoaThr", "dayMinHours", "dayMinWh", "irrAllIntervals"]) delete pr[k];
    // Older models excluded whole days: { day, reason } → a 00:00–24:00 period
    days.excluded = (days.excluded ?? []).map((e) => {
        const o = e as Partial<Exclusion> & { day?: string };
        if (o.from !== undefined) return { from: o.from, to: o.to ?? "", cause: o.cause ?? "Other", reason: o.reason ?? "", evidence: o.evidence ?? "" };
        const day = o.day ?? "";
        const next = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(Date.parse(day) + 864e5).toISOString().slice(0, 10) : "";
        return { from: day ? `${day}T00:00` : "", to: next ? `${next}T00:00` : "", cause: "Other", reason: o.reason ?? "", evidence: "" };
    });
    return { ...d, ...c, qc: { ...d.qc, ...c.qc }, thr: { ...d.thr, ...c.thr }, epi: { ...d.epi, ...c.epi }, pr, days, meter: { ...d.meter, ...c.meter } };
}

// ── Contract procedures ───────────────────────────────────────────────
// Starting points taken from the signed test procedures. They only set the
// rules; project values (POI limit, P_stc, monthly table…) stay as entered.

export type ProcedureKey = "PLAZA" | "TERRER" | "HORUS" | "ENSOL";

export interface ProcedureFacts { guarantee: string; resolution: string; validDay: string; period: string; filtering: string; intervals: string; other: string }
export const PROCEDURES: { key: ProcedureKey; type: TestType; title: string; facts: ProcedureFacts }[] = [
    { key: "PLAZA", type: "EPI", title: "Plaza I / II", facts: {
        guarantee: "EPI ≥ 98 %", resolution: "15 min", validDay: "3 h with POA ≥ 500 W/m²", period: "10 valid days within 15 (fallback: 6 best days)",
        filtering: "IQR on GHI, POA and ambient temperature; pyranometers more than 4 % from the average are discarded",
        intervals: "GHI, POA and T_AMB recorded; POA ≥ 100 W/m²; no curtailment, suspension or force majeure",
        other: "Valid days need not be consecutive" } },
    { key: "TERRER", type: "EPI", title: "Terrer", facts: {
        guarantee: "EPI ≥ 98 %", resolution: "Hourly", validDay: "—", period: "10 valid days within 20",
        filtering: "IQR on POA and temperature; GHI and DHI sensors more than 5 % from the daily average are dropped for the day; T_AMB rounds at 10 % and 5 ºC",
        intervals: "GHI, DHI and T_AMB recorded; POA ≥ 100 W/m²; inverters producing; no curtailment or stow",
        other: "At least 10 h over the test with POA ≥ 600 W/m² (Apr–Sep) or 400 W/m² (Oct–Mar)" } },
    { key: "HORUS", type: "EPI", title: "Horus III", facts: {
        guarantee: "EPI ≥ 98 %", resolution: "15 min", validDay: "—", period: "10 valid days within 20",
        filtering: "IQR on GHI",
        intervals: "GHI > 10 W/m²; POA > 0 W/m²; albedo recorded",
        other: "External events are excluded or replaced by the expected energy" } },
    { key: "ENSOL", type: "PR", title: "Ensol I", facts: {
        guarantee: "PR ≥ 0.97 × design PR (ΣE / ΣP′)", resolution: "15 min", validDay: "3 h at ≥ 500 W/m² and > 3,000 Wh/m²", period: "10 valid days within 15",
        filtering: "A pyranometer more than ±5 % from the daily average is excluded for the day; gaps of up to 4 intervals interpolated (≤ 1 % of the day)",
        intervals: "POA ≥ 100 W/m²; energy, POA and cell temperature recorded; plant injecting",
        other: "Measured albedo within 0.17 ± 20 %" } },
];

/**
 * IQR cannot remove anything with fewer than 4 sensors, so it is not offered
 * then: a parameter left on IQR with 1–3 sensors switches to "None" (same result).
 */
export function fitFilters(c: ModelConfig): ModelConfig {
    let out: ModelConfig | null = null;
    for (const [p, f] of Object.entries(c.filters) as [ParamId, ParamFilter | undefined][]) {
        if (!f || f.method !== "IQR") continue;
        if (sensorsOf(c.mapping, p).length >= 4 || c.mapping.length === 0) continue;
        out ??= { ...c, filters: { ...c.filters } };
        out.filters[p] = { ...f, method: "NONE" };
    }
    return out ?? c;
}

export function applyProcedure(c: ModelConfig, key: ProcedureKey): ModelConfig {
    const base = defaultConfig(PROCEDURES.find((p) => p.key === key)!.type);
    const out: ModelConfig = { ...base, project: c.project, mapping: c.mapping, albedo: c.albedo, periodStart: c.periodStart, periodEnd: c.periodEnd, meter: { ...base.meter, ...c.meter } };
    out.thr = { ...base.thr, poiKw: c.thr.poiKw, setpointMin: c.thr.setpointMin };
    if (c.type === out.type) { out.pr = { ...c.pr }; out.epi = { ...c.epi }; }
    const none = { method: "NONE" as const, rounds: [], dailyTol: 0.05, dailyTwoSided: true };
    switch (key) {
        case "PLAZA":
            out.filters = {
                GHI: { ...none, method: "IQR", rounds: [{ pct: 0.04, abs: 0 }] },
                POA: { ...none, method: "IQR", rounds: [{ pct: 0.04, abs: 0 }] },
                T_AMB: { ...none, method: "IQR" },
                DHI: { ...none }, REF: { ...none }, T_MOD: { ...none },
            };
            out.criteria = [
                { id: "avail", type: "available", on: true, label: "GHI, POA and T_AMB recorded", params: ["GHI", "POA", "T_AMB"] },
                { id: "floor", type: "poaFloor", on: true, label: "POA ≥ 100 W/m² (start/end of the sampling day)" },
                { id: "curt", type: "curtailment", on: true, label: "Criterion 3: utility curtailment, owner / authority suspension, force majeure", windAlarm: false, pf: false },
                { id: "manual", type: "manual", on: true, label: "Criterion 3: other events not attributable to the Contractor (edit 1 → 0)" },
            ];
            out.days = { ...base.days, required: 10, maxWindow: 15, fallbackTopK: 6, minHours: 3, hoursPoaThr: 500 };
            out.epi.guaranteedEpi = 0.98;
            break;
        case "TERRER":
            out.filters = {
                GHI: { ...none, method: "DAILY_MEAN", dailyTol: 0.05 },
                DHI: { ...none, method: "DAILY_MEAN", dailyTol: 0.05 },
                POA: { ...none, method: "IQR" },
                T_AMB: { ...none, method: "IQR", rounds: [{ pct: 0.1, abs: 5 }] },
                REF: { ...none }, T_MOD: { ...none },
            };
            out.criteria = [
                { id: "avail", type: "available", on: true, label: "GHI, DHI and T_AMB recorded (null averages make the step unavailable)", params: ["GHI", "DHI", "T_AMB"] },
                { id: "floor", type: "poaFloor", on: true, label: "Criterion 4: POA ≥ 100 W/m²" },
                { id: "export", type: "exporting", on: false, label: "Criterion 4: inverters still delivering energy (needs the meter in the SCADA file)" },
                { id: "agg", type: "aggHours", on: true, label: "Criterion 5: 10 h of POA ≥ 600 W/m² (Apr–Sep) / 400 W/m² (Oct–Mar) over the test", aboveSeasonal: true },
                { id: "curt", type: "curtailment", on: true, label: "Criterion 6: utility curtailment and stow position excluded", windAlarm: true, pf: false },
                { id: "manual", type: "manual", on: true, label: "Criterion 6: owner instructions, outages, damages, force majeure (edit 1 → 0)" },
            ];
            out.thr = { ...out.thr, poaThrSummer: 600, poaThrWinter: 400, summerStart: 4, summerEnd: 9, minHoursTest: 10 };
            out.epi.aggregateByHour = true;
            out.days = { ...base.days, required: 10, maxWindow: 20 };
            break;
        case "HORUS":
            out.filters = {
                GHI: { ...none, method: "IQR" },
                POA: { ...none }, DHI: { ...none }, T_AMB: { ...none }, REF: { ...none }, T_MOD: { ...none },
            };
            out.criteria = [
                { id: "ghi10", type: "threshold", on: true, label: "Criterion 1: average GHI above 10 W/m²", param: "GHI", op: ">", value: 10 },
                { id: "poa0", type: "threshold", on: true, label: "Criterion 2: POA above 0 W/m²", param: "POA", op: ">", value: 0 },
                { id: "alb", type: "available", on: true, label: "Criterion 3: albedo recorded", params: ["ALB"] },
                { id: "event", type: "manual", on: true, label: "Criterion 4: external events (edit 1 → 0)", replaceWithExpected: false },
            ];
            out.epi.aggregateByHour = false;
            out.days = { ...base.days, required: 10, maxWindow: 20 };
            break;
        case "ENSOL":
            out.filters = {
                POA: { ...none, method: "DAILY_MEAN", dailyTol: 0.05, dailyTwoSided: true },
                T_MOD: { ...none }, GHI: { ...none }, DHI: { ...none }, T_AMB: { ...none }, REF: { ...none },
            };
            out.criteria = [
                { id: "floor", type: "poaFloor", on: true, label: "Criterion 1: POA ≥ 100 W/m²" },
                { id: "missing", type: "noMissing", on: true, label: "Criterion 2: energy, POA and T_cell recorded (night excepted)", params: ["POA", "T_MOD", "E_GRID"], exceptWhenFloorFails: true },
                { id: "export", type: "exporting", on: true, label: "Criterion 3: 100 % availability — every interval with POA ≥ 100 W/m² of the day injects energy", dayLevel: true },
                { id: "setpoint", type: "setpointMin", on: true, label: "Criterion 5: no grid limitation (setpoint at or above the minimum)" },
                { id: "stow", type: "curtailment", on: false, label: "Criterion 5: tracker wind-defence mode", windAlarm: true, pf: false },
                { id: "events", type: "manual", on: true, label: "Criterion 5: force majeure, owner stops, grid failures… (edit 1 → 0)" },
            ];
            out.thr = { ...out.thr, poiKw: 0 };
            out.qc = { ...out.qc, interpMaxGap: 4 };
            out.days = { ...base.days, required: 10, maxWindow: 15, minHours: 3, hoursPoaThr: 500, minDailyWh: 3000, irrAllIntervals: true, maxInterpPct: 0.01 };
            out.pr = { ...out.pr, ft: 0.97, overall: "weighted", albedoBase: 0.17, albedoTol: 0.2 };
            break;
    }
    return out;
}
