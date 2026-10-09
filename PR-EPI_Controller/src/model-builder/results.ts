//-----------------------------------------------------------------------
// Results sheets.
//  EPI: 05 PVsyst Results, 05b Meter, 06 Production Comparison, 07 Daily Summary
//  PR : 04 Daily Results
// Same pattern as the engine: values computed here + the formulas that
// reproduce them in Excel.
//-----------------------------------------------------------------------

import { ColumnSheet, average, bucketMin, isNum, type Plan } from "./engine";
import { tr } from "./i18n";
import { addDaySelection, type DaySelection } from "./days";
import type { MeterTable, PvsystTable, Val } from "./types";

function addInput(plan: Plan, name: string, label: string, value: number, unit: string, group: string, note?: string) {
    if (plan.I[name] !== undefined) return;
    plan.I[name] = value;
    plan.inputs.push({ name, label, value, unit, group, note });
}

const sum = (v: Val[]) => v.filter(isNum).reduce((a, b) => a + b, 0);

// ── EPI ───────────────────────────────────────────────────────────────
export interface EpiResults {
    pvsyst: ColumnSheet;
    meter?: ColumnSheet;
    comp: ColumnSheet;
    daily: ColumnSheet;
    days: DaySelection;
    kpi: {
        expectedKwh: number;
        guaranteedKwh: number;
        measuredKwh: number;
        deviation: number | null;
        epiMeasured: number | null;
        validIntervals: number;
        validDays: number;
        pass: boolean;
        first: number | null; // serial
        last: number | null;
    };
}

/** Key rule shared by SCADA and meter (end-of-interval stamps). */
const dataKey = (m: number, hourly: boolean) => (hourly ? Math.floor((m - 1) / 60) : m);

export function buildEpiResults(plan: Plan, pv: PvsystTable, meter: MeterTable | null): EpiResults {
    const { cfg, sheet: s3 } = plan;
    const L = tr(cfg.project.lang);
    const hourly = cfg.epi.aggregateByHour;
    const bMin = bucketMin(cfg, plan.ds.stepMin);
    const bucketH = bMin / 60;
    addInput(plan, "Guaranteed_EPI", "Guaranteed EPI", cfg.epi.guaranteedEpi, "-", "Contract");
    addInput(plan, "Degradation", "Degradation factor", cfg.epi.degradation, "-", "Contract");
    addInput(plan, "Availability", "Availability factor", cfg.epi.availability, "-", "Contract");
    addInput(plan, "TimeShift_min", "Minutes added to PVsyst timestamps", cfg.epi.timeShiftMin, "min", "Contract");
    addInput(plan, "Bucket_h", "Comparison step", bucketH, "h", "Contract");
    addInput(plan, "Intervals_per_bucket", "SCADA intervals per comparison step (all must be valid)", Math.round(bMin / plan.ds.stepMin), "-", "Contract");
    const factor = cfg.epi.guaranteedEpi * cfg.epi.degradation * cfg.epi.availability;
    const ipb = plan.I.Intervals_per_bucket;

    // Data keys present in sheet 03
    const keyVals = s3.get("Key").values as number[];
    const dataKeys = new Set(keyVals);
    const minK = Math.min(...keyVals), maxK = Math.max(...keyVals);

    // 05 PVsyst ----------------------------------------------------------------
    const pvKey = (m: number) => { const sm = m + cfg.epi.timeShiftMin; return hourly ? Math.floor(sm / 60) : sm; };
    const pvRows = pv.t.map((m, i) => i).filter((i) => { const k = pvKey(pv.t[i]); return k >= minK && k <= maxK; });
    const s5 = new ColumnSheet(L.sPvsyst, pvRows.length);
    s5.add({ id: "date", header: "date (PVsyst)", kind: "value", group: "time", values: pvRows.map((i) => pv.t[i] / 1440), numFmt: "dd/mm/yyyy hh:mm", width: 17 });
    s5.add({ id: "Shifted", header: "Date (shifted)", kind: "formula", group: "time", values: pvRows.map((i) => (pv.t[i] + cfg.epi.timeShiftMin) / 1440), f: (r) => `${s5.c("date", r)}+TimeShift_min/1440`, numFmt: "dd/mm/yyyy hh:mm", width: 17 });
    s5.add({ id: "Key", header: hourly ? "Hour key" : "Interval key", kind: "formula", group: "time", values: pvRows.map((i) => pvKey(pv.t[i])), f: (r) => (hourly ? `INT(ROUND(${s5.c("Shifted", r)}*24,6))` : `ROUND(${s5.c("Shifted", r)}*1440,0)`), numFmt: "0", width: 10 });
    for (const h of pv.headers) s5.add({ id: h, header: h, kind: "value", group: "data", values: pvRows.map((i) => pv.cols[h][i]), numFmt: "0.00", width: 10 });

    // 05b Meter -------------------------------------------------------------------
    let s5b: ColumnSheet | undefined;
    const unit = cfg.meter.unit;
    let netRange = "", netKeyRange = "", netVals: Val[] = [], netKeys: number[] = [], netIsPower = true;
    if (cfg.meter.source === "scada") {
        if (!plan.eNet) throw new Error("The meter is set to come from the SCADA file, but no E_GRID column is mapped.");
        netRange = s3.xr(plan.eNet); netKeyRange = s3.xr("Key");
        netVals = s3.get(plan.eNet).values; netKeys = keyVals; netIsPower = true;
    } else if (meter) {
        s5b = new ColumnSheet(L.sMeter, meter.t.length);
        const sm = s5b;
        const two = cfg.meter.mode === "two";
        const stepH = meter.stepMin / 60;
        addInput(plan, "Meter_Step_h", "Meter interval length", stepH, "h", "Contract");
        sm.add({ id: "Date", header: "Date", kind: "value", group: "time", values: meter.t.map((m) => m / 1440), numFmt: "dd/mm/yyyy hh:mm", width: 17 });
        sm.add({ id: "Key", header: hourly ? "Hour key" : "Interval key", kind: "formula", group: "time", values: meter.t.map((m) => dataKey(m, hourly)), f: (r) => (hourly ? `INT(ROUND((${sm.c("Date", r)}*1440-1)/60,6))` : `ROUND(${sm.c("Date", r)}*1440,0)`), numFmt: "0", width: 10 });
        sm.add({ id: "Production", header: cfg.meter.prodCol || "Production", kind: "value", group: "data", values: meter.prod, numFmt: "0.00", width: 16 });
        if (two) sm.add({ id: "Consumption", header: cfg.meter.consCol || "Consumption", kind: "value", group: "data", values: meter.cons, numFmt: "0.00", width: 16 });
        const netAt = (i: number): Val => {
            const a = meter.prod[i];
            if (!isNum(a)) return "";
            if (!two) return a;
            const b = meter.cons[i];
            return a - Math.abs(isNum(b) ? b : 0);
        };
        const netF = (r: number) => (two ? `(${sm.c("Production", r)}-ABS(N(${sm.c("Consumption", r)})))` : sm.c("Production", r));
        const hdr = unit === "power" ? "Net (kW)" : "Net energy (kWh)";
        sm.add({
            id: "Net", header: hdr, kind: "formula", group: "result", numFmt: "0.00", width: 13,
            note: two ? "Production − |Consumption|: works whether import is reported positive or negative." : cfg.meter.mode === "net" ? "Single bidirectional column, already net." : "Production only.",
            values: meter.t.map((_, i) => {
                if (unit === "counter") { if (i === 0) return ""; const a = netAt(i), b = netAt(i - 1); return isNum(a) && isNum(b) ? a - b : ""; }
                return netAt(i);
            }),
            f: (r) => {
                const a = sm.c("Production", r);
                if (unit === "counter") return r === 2 ? `""` : `IF(AND(ISNUMBER(${a}),ISNUMBER(${sm.c("Production", r - 1)})),${netF(r)}-${netF(r - 1)},"")`;
                return `IF(ISNUMBER(${a}),${netF(r)},"")`;
            },
        });
        netRange = sm.xr("Net"); netKeyRange = sm.xr("Key");
        netVals = sm.get("Net").values; netKeys = sm.get("Key").values as number[]; netIsPower = unit === "power";
    }

    // Index helpers ---------------------------------------------------------------
    const group = (keys: number[], vals: Val[]) => {
        const m = new Map<number, Val[]>();
        keys.forEach((k, i) => { if (!m.has(k)) m.set(k, []); m.get(k)!.push(vals[i]); });
        return m;
    };
    const pvK = s5.get("Key").values as number[];
    const gGlobEff = group(pvK, s5.has("GlobEff") ? s5.get("GlobEff").values : []);
    const gEgrid = group(pvK, s5.get("E_Grid").values);
    const gNet = group(netKeys, netVals);
    const fin = plan.final;
    const gFinal = (p: "GHI" | "POA" | "T_AMB") => (fin[p] ? group(keyVals, s3.get(fin[p]!).values) : null);
    const gGHI = gFinal("GHI"), gPOA = gFinal("POA"), gTA = gFinal("T_AMB");
    const comply = s3.get(plan.comply).values;
    const validCount = new Map<number, number>();
    keyVals.forEach((k, i) => { if (comply[i] === 1) validCount.set(k, (validCount.get(k) ?? 0) + 1); });

    // 06 Comparison ----------------------------------------------------------------
    const keys = Array.from(new Set(pvK)).filter((k) => dataKeys.has(k)).sort((a, b) => a - b);
    const s6 = new ColumnSheet(L.sComp, keys.length);
    const kSerial = (k: number) => (hourly ? k / 24 : k / 1440);
    s6.add({ id: "Date", header: "Date", kind: "value", group: "time", values: keys.map(kSerial), numFmt: "dd/mm/yyyy hh:mm", width: 17 });
    s6.add({ id: "Key", header: hourly ? "Hour key" : "Interval key", kind: "formula", group: "time", values: keys, f: (r) => (hourly ? `ROUND(${s6.c("Date", r)}*24,0)` : `ROUND(${s6.c("Date", r)}*1440,0)`), numFmt: "0", width: 10 });
    const avgIfs = (rng: string, keyRng: string) => (r: number) => `IFERROR(AVERAGEIFS(${rng},${keyRng},${s6.c("Key", r)}),"")`;
    if (s5.has("GlobEff")) s6.add({ id: "ExpPOA", header: "Expected POA (W/m²)", kind: "formula", group: "data", numFmt: "0.00", width: 12, values: keys.map((k) => average(gGlobEff.get(k) ?? [])), f: avgIfs(s5.xr("GlobEff"), s5.xr("Key")) });
    s6.add({ id: "Exp", header: "Expected production (kW)", kind: "formula", group: "data", numFmt: "0.00", width: 13, values: keys.map((k) => average(gEgrid.get(k) ?? [])), f: avgIfs(s5.xr("E_Grid"), s5.xr("Key")) });
    s6.add({
        id: "Guar", header: "Guaranteed production (kW)", kind: "formula", group: "result", numFmt: "0.00", width: 13,
        values: s6.get("Exp").values.map((v) => (isNum(v) ? factor * v : "")),
        f: (r) => `IF(ISNUMBER(${s6.c("Exp", r)}),Guaranteed_EPI*Degradation*Availability*${s6.c("Exp", r)},"")`,
    });
    const hasMeter = netRange !== "";
    if (hasMeter) {
        s6.add({
            id: "Meas", header: "Measured net production (kW)", kind: "formula", group: "result", numFmt: "0.00", width: 13,
            values: keys.map((k) => {
                const v = gNet.get(k) ?? [];
                if (netIsPower) return average(v);
                if (!v.length) return "";
                return sum(v) / bucketH;
            }),
            f: netIsPower ? avgIfs(netRange, netKeyRange) : (r) => `IF(COUNTIFS(${netKeyRange},${s6.c("Key", r)})=0,"",SUMIFS(${netRange},${netKeyRange},${s6.c("Key", r)})/Bucket_h)`,
        });
    }
    const addMeas = (id: string, header: string, g: Map<number, Val[]> | null, src?: string) => {
        if (!g || !src) return;
        s6.add({ id, header, kind: "formula", group: "data", numFmt: "0.00", width: 12, values: keys.map((k) => average(g.get(k) ?? [])), f: avgIfs(s3.xr(src), s3.xr("Key")) });
    };
    addMeas("MGHI", "Measured GHI (W/m²)", gGHI, fin.GHI);
    addMeas("MPOA", "Measured POA (W/m²)", gPOA, fin.POA);
    addMeas("MTA", "Measured T_AMB (ºC)", gTA, fin.T_AMB);
    s6.add({ id: "VI", header: "Valid intervals", kind: "formula", group: "crit", numFmt: "0", width: 9, values: keys.map((k) => validCount.get(k) ?? 0), f: (r) => `COUNTIFS(${s3.xr("Key")},${s6.c("Key", r)},${s3.xr(plan.comply)},1)` });
    s6.add({ id: "V", header: "Valid", kind: "formula", group: "crit", numFmt: "0", width: 7, values: keys.map((k) => ((validCount.get(k) ?? 0) >= ipb ? 1 : 0)), f: (r) => `IF(${s6.c("VI", r)}>=Intervals_per_bucket,1,0)` });
    const valid = s6.get("V").values as number[];
    s6.add({ id: "Day", header: "Day", kind: "formula", group: "time", numFmt: "dd/mm/yyyy", width: 11, values: keys.map((k) => Math.floor(kSerial(k))), f: (r) => `INT(${s6.c("Date", r)})` });
    const dayOf = s6.get("Day").values as number[];

    // 07 Daily: validity and selection of test days -------------------------------
    const days = Array.from(new Set(dayOf)).sort((a, b) => a - b);
    const s7 = new ColumnSheet(L.sDaily, days.length);
    const sumDay = (id: string, d: number) => sum(s6.get(id).values.filter((_, i) => dayOf[i] === d));
    s7.add({ id: "Day", header: "Day", kind: "value", group: "time", values: days, numFmt: "dd/mm/yyyy", width: 12 });
    s7.add({ id: "VI", header: "Valid steps", kind: "formula", group: "crit", numFmt: "0", width: 9, values: days.map((d) => sumDay("V", d)), f: (r) => `SUMIFS(${s6.xr("V")},${s6.xr("Day")},${s7.c("Day", r)})` });
    const selDays = addDaySelection(plan, s7, "VI");
    const selOfDay = new Map(days.map((d, i) => [d, selDays.selected[i]]));

    // Back in 06: steps of the days used in the test --------------------------------
    s6.add({
        id: "DSel", header: "Day used in the test", kind: "formula", group: "crit", numFmt: "0", width: 9,
        values: dayOf.map((d) => selOfDay.get(d) ?? 0),
        f: (r) => `SUMIFS(${s7.xr("Sel")},${s7.xr("Day")},${s6.c("Day", r)})`,
    });
    const counted = valid.map((v, i) => v * ((s6.get("DSel").values[i] as number) ?? 0));
    s6.add({ id: "Cnt", header: "Counted", kind: "formula", group: "crit", numFmt: "0", width: 8, values: counted, f: (r) => `${s6.c("V", r)}*${s6.c("DSel", r)}` });

    // External events: measured replaced by expected (Horus III criterion 4)
    let measSrc = "Meas";
    if (hasMeter && plan.eventCols.length) {
        const evRows = new Map<number, number>();
        keyVals.forEach((k, i) => { if (plan.eventCols.some((c) => s3.get(c).values[i] === 0)) evRows.set(k, 1); });
        s6.add({
            id: "Ev", header: "External event", kind: "formula", group: "crit", numFmt: "0", width: 9,
            values: keys.map((k) => evRows.get(k) ?? 0),
            f: (r) => `IF(${plan.eventCols.map((c) => `COUNTIFS(${s3.xr("Key")},${s6.c("Key", r)},${s3.xr(c)},0)`).join("+")}>0,1,0)`,
        });
        s6.add({
            id: "MeasU", header: "Measured used (kW)", kind: "formula", group: "result", numFmt: "0.00", width: 13,
            note: "Measured production, replaced by the expected production in steps with an external event",
            values: keys.map((_, i) => (s6.get("Ev").values[i] === 1 ? s6.get("Exp").values[i] : s6.get("Meas").values[i])),
            f: (r) => `IF(${s6.c("Ev", r)}=1,${s6.c("Exp", r)},${s6.c("Meas", r)})`,
        });
        measSrc = "MeasU";
    }
    const vcol = (id: string, header: string, src: string) => s6.add({
        id, header, kind: "formula", group: "result", numFmt: "0.00", width: 13,
        values: s6.get(src).values.map((v, i) => (counted[i] === 1 ? v : "")),
        f: (r) => `IF(${s6.c("Cnt", r)}=1,${s6.c(src, r)},"")`,
    });
    vcol("VExp", "Counted expected production (kW)", "Exp");
    vcol("VGuar", "Counted guaranteed production (kW)", "Guar");
    if (hasMeter) vcol("VMeas", "Counted measured production (kW)", measSrc);
    if (s6.has("MPOA")) vcol("VPOA", "Counted measured POA (W/m²)", "MPOA");
    // Chart helpers: #N/A instead of "" outside the counted steps, so Excel charts leave a gap instead of a zero
    const ccol = (id: string, header: string, src: string) => s6.add({
        id, header, kind: "formula", group: "result", numFmt: "0.00", width: 11,
        note: "For the charts only: #N/A outside the counted steps, so the chart leaves a gap.",
        values: s6.get(src).values.map((v, i) => (counted[i] === 1 && typeof v === "number" ? v : "#N/A")),
        f: (r) => `IF(AND(${s6.c("Cnt", r)}=1,ISNUMBER(${s6.c(src, r)})),${s6.c(src, r)},NA())`,
    });
    ccol("ChExp", "Chart · expected (kW)", "Exp");
    ccol("ChGuar", "Chart · guaranteed (kW)", "Guar");
    if (hasMeter) ccol("ChMeas", "Chart · measured (kW)", measSrc);

    const eCol = (id: string, header: string, src: string) => s7.add({
        id, header, kind: "formula", group: "result", numFmt: "#,##0.0", width: 15,
        values: days.map((d) => sumDay(src, d) * bucketH),
        f: (r) => `SUMIFS(${s6.xr(src)},${s6.xr("Day")},${s7.c("Day", r)})*Bucket_h`,
    });
    eCol("Exp", "Counted expected (kWh)", "VExp");
    eCol("Guar", "Counted guaranteed (kWh)", "VGuar");
    if (hasMeter) {
        eCol("Meas", "Counted measured (kWh)", "VMeas");
        s7.add({
            id: "Dev", header: "Deviation", kind: "formula", group: "result", numFmt: "0.00%", width: 10,
            values: days.map((_, i) => { const g = s7.get("Guar").values[i] as number, m = s7.get("Meas").values[i] as number; return g > 0 ? m / g - 1 : ""; }),
            f: (r) => `IF(${s7.c("Guar", r)}>0,${s7.c("Meas", r)}/${s7.c("Guar", r)}-1,"")`,
        });
    }

    const expectedKwh = sum(s6.get("VExp").values) * bucketH;
    const guaranteedKwh = sum(s6.get("VGuar").values) * bucketH;
    const measuredKwh = hasMeter ? sum(s6.get("VMeas").values) * bucketH : 0;
    const dts = s6.get("Date").values as number[];
    return {
        pvsyst: s5, meter: s5b, comp: s6, daily: s7, days: selDays,
        kpi: {
            expectedKwh, guaranteedKwh, measuredKwh,
            deviation: hasMeter && guaranteedKwh > 0 ? measuredKwh / guaranteedKwh - 1 : null,
            epiMeasured: hasMeter && expectedKwh > 0 ? measuredKwh / expectedKwh : null,
            validIntervals: counted.reduce((a, b) => a + b, 0),
            validDays: selDays.daysSelected,
            pass: hasMeter && measuredKwh >= guaranteedKwh,
            first: dts.length ? Math.min(...dts) : null,
            last: dts.length ? Math.max(...dts) : null,
        },
    };
}

// ── PR ────────────────────────────────────────────────────────────────
export interface PrResults {
    daily: ColumnSheet;
    days: DaySelection;
    kpi: {
        prGuaranteed: number;
        prMean: number;
        prWeighted: number;
        prReal: number;
        deviation: number;
        validDays: number;
        days: number;
        pass: boolean;
        albedo: number | null;
    };
}

export function buildPrResults(plan: Plan): PrResults {
    const { cfg, sheet: s3, ds } = plan;
    const L = tr(cfg.project.lang);
    const pr = cfg.pr;
    const poa = plan.final.POA;
    if (!poa || !plan.eNet || !s3.has("PR'_i (kW)")) throw new Error("PR needs POA, T_MOD and a meter (E_GRID) column mapped.");
    addInput(plan, "Intervals_per_h", "SCADA intervals per hour", 60 / ds.stepMin, "-", "PR");
    const day = s3.get("Day").values as number[];
    const comply = s3.get(plan.comply).values;
    const e = s3.get(plan.eNet).values, ref = s3.get("PR'_i (kW)").values;
    const days = Array.from(new Set(day)).sort((a, b) => a - b);
    const sd = new ColumnSheet(L.sDailyPR, days.length);
    const by = (d: number, fn: (i: number) => boolean, vals: Val[]) => sum(vals.filter((_, i) => day[i] === d && fn(i)));
    const ok = (i: number) => comply[i] === 1;
    sd.add({ id: "Day", header: "Day", kind: "value", group: "time", values: days, numFmt: "dd/mm/yyyy", width: 12 });
    sd.add({ id: "VI", header: "Valid intervals", kind: "formula", group: "crit", numFmt: "0", width: 9, values: days.map((d) => day.filter((dd, i) => dd === d && ok(i)).length), f: (r) => `COUNTIFS(${s3.xr("Day")},${sd.c("Day", r)},${s3.xr(plan.comply)},1)` });
    sd.add({ id: "E", header: "Σ E valid (kW)", kind: "formula", group: "data", numFmt: "#,##0.00", width: 14, values: days.map((d) => by(d, ok, e)), f: (r) => `SUMIFS(${s3.xr(plan.eNet!)},${s3.xr("Day")},${sd.c("Day", r)},${s3.xr(plan.comply)},1)` });
    sd.add({ id: "R", header: "Σ PR' valid (kW)", kind: "formula", group: "data", numFmt: "#,##0.00", width: 14, values: days.map((d) => by(d, ok, ref)), f: (r) => `SUMIFS(${s3.xr("PR'_i (kW)")},${s3.xr("Day")},${sd.c("Day", r)},${s3.xr(plan.comply)},1)` });
    sd.add({ id: "PRp", header: "PRp (day)", kind: "formula", group: "result", numFmt: "0.00%", width: 9, values: days.map((_, i) => { const a = sd.get("E").values[i] as number, b = sd.get("R").values[i] as number; return b !== 0 ? a / b : 0; }), f: (r) => `IFERROR(${sd.c("E", r)}/${sd.c("R", r)},0)` });
    sd.add({ id: "PRd", header: "PRd", kind: "formula", group: "result", numFmt: "0.00%", width: 9, values: days.map((d) => pr.ft * pr.prDesign[new Date((d - 25569) * 86400000).getUTCMonth()]), f: (r) => `FT*INDEX(PR_Design_Month,MONTH(${sd.c("Day", r)}))` });
    const sel = addDaySelection(plan, sd, "VI");
    const S = sel.selected;
    const nv = S.reduce((a, b) => a + b, 0);
    const sp = (id: string) => (sd.get(id).values as number[]).reduce((a, x, i) => a + x * S[i], 0);
    const prGuaranteed = nv ? sp("PRd") / nv : 0;
    const prMean = nv ? sp("PRp") / nv : 0;
    const rr = sp("R");
    const prWeighted = rr ? sp("E") / rr : 0;
    const prReal = pr.overall === "weighted" ? prWeighted : prMean;
    // Measured albedo over the valid intervals of the days used (Ensol: ±20 % from the model value → recalculate PR_D)
    let albedo: number | null = null;
    if (plan.final.ALB) {
        const alb = plan.final.ALB;
        const a = s3.get(alb).values;
        sd.add({ id: "AlbS", header: "Σ albedo (valid)", kind: "formula", group: "data", numFmt: "0.000", width: 10, values: days.map((d) => by(d, ok, a)), f: (r) => `SUMIFS(${s3.xr(alb)},${s3.xr("Day")},${sd.c("Day", r)},${s3.xr(plan.comply)},1)` });
        sd.add({ id: "AlbN", header: "n albedo (valid)", kind: "formula", group: "data", numFmt: "0", width: 9, values: days.map((d) => day.filter((dd, i) => dd === d && ok(i) && isNum(a[i]) && (a[i] as number) >= 0).length), f: (r) => `COUNTIFS(${s3.xr("Day")},${sd.c("Day", r)},${s3.xr(plan.comply)},1,${s3.xr(alb)},">=0")` });
        const n = (sd.get("AlbN").values as number[]).reduce((x, v, i) => x + v * S[i], 0);
        albedo = n ? (sd.get("AlbS").values as number[]).reduce((x, v, i) => x + v * S[i], 0) / n : null;
        addInput(plan, "Albedo_Base", "Albedo of the design model", pr.albedoBase, "-", "PR");
        addInput(plan, "Albedo_Tol", "Allowed relative deviation of the measured albedo", pr.albedoTol, "fraction", "PR");
    }
    return {
        daily: sd, days: sel,
        kpi: { prGuaranteed, prMean, prWeighted, prReal, deviation: prGuaranteed ? (prReal - prGuaranteed) / prGuaranteed : 0, validDays: nv, days: days.length, pass: prReal >= prGuaranteed, albedo },
    };
}
