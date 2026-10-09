//-----------------------------------------------------------------------
// Valid days and test period, shared by PR (04) and EPI (07).
//  · day criteria: hours of valid intervals with POA ≥ threshold, daily
//    irradiation, share of interpolated intervals, days excluded by hand
//  · test period: the first N valid days within the window (e.g. 10 within
//    15 or 20 calendar days); optional fallback to the K days with the
//    highest irradiation when the window ends without N valid days (Plaza)
//-----------------------------------------------------------------------

import { exclusionPeriods, isNum, type ColumnSheet, type Plan } from "./engine";
import type { Val } from "./types";

export interface DaySelection {
    valid: number[];
    selected: number[];
    fallbackActive: boolean;
    daysSelected: number;
    daysNeeded: number;
    complete: boolean;
    validDays: number;
    windowDays: number;
}

function addInput(plan: Plan, name: string, label: string, value: number, unit: string, group: string) {
    if (plan.I[name] !== undefined) return;
    plan.I[name] = value;
    plan.inputs.push({ name, label, value, unit, group });
}

/**
 * Appends the day-validity and selection columns to a daily sheet whose
 * "Day" column holds day serials and whose `baseCol` counts valid
 * intervals/steps of the day (> 0 = the day has data that counts).
 */
export function addDaySelection(plan: Plan, sd: ColumnSheet, baseCol: string): DaySelection {
    const { cfg, sheet: s3 } = plan;
    const dc = cfg.days;
    addInput(plan, "Step_h", "Interval length of the SCADA data", plan.stepH, "h", "Data");
    addInput(plan, "Required_Days", "Valid days required by the test (0 = no requirement)", dc.required, "days", "Test period");
    addInput(plan, "Max_Window_Days", "Maximum calendar days from the first test day (0 = no limit)", dc.maxWindow, "days", "Test period");
    addInput(plan, "Fallback_Days", "If the window ends without enough valid days, use the K days with the highest irradiation (0 = off)", dc.fallbackTopK, "days", "Test period");
    addInput(plan, "Day_POA_Thr", "Valid day: POA threshold for counting hours", dc.hoursPoaThr, "W/m²", "Valid day");
    addInput(plan, "Day_Min_Hours", "Valid day: minimum hours of valid intervals with POA ≥ threshold (0 = off)", dc.minHours, "h", "Valid day");
    addInput(plan, "Day_Min_Wh", "Valid day: daily POA irradiation must exceed (0 = off)", dc.minDailyWh, "Wh/m²", "Valid day");
    const useInterp = !!plan.interpCol;
    if (useInterp) addInput(plan, "Max_Interp_Pct", "Valid day: maximum share of interpolated intervals among valid ones", dc.maxInterpPct, "fraction", "Valid day");
    const periods = exclusionPeriods(plan.cfg);

    const day3 = s3.get("Day").values as number[];
    const comply = s3.get(plan.comply).values;
    const poa = plan.final.POA;
    const poaV = poa ? s3.get(poa).values : [];
    const interp = useInterp ? (s3.get(plan.interpCol!).values as number[]) : [];
    const days = sd.get("Day").values as number[];
    const D = (r: number) => sd.c("Day", r);
    const ok = (i: number) => comply[i] === 1;

    // Hours with POA ≥ threshold among valid intervals
    sd.add({
        id: "Hours", header: "Valid hours POA ≥ thr.", kind: "formula", group: "crit", numFmt: "0.00", width: 12,
        values: days.map((d) => day3.filter((dd, i) => dd === d && ok(i) && isNum(poaV[i]) && (poaV[i] as number) >= dc.hoursPoaThr).length * plan.stepH),
        f: (r) => (poa ? `COUNTIFS(${s3.xr("Day")},${D(r)},${s3.xr(plan.comply)},1,${s3.xr(poa)},">="&Day_POA_Thr)*Step_h` : "0"),
    });
    // Daily irradiation (Wh/m²)
    sd.add({
        id: "Irr", header: "Daily irradiation (Wh/m²)", kind: "formula", group: "crit", numFmt: "#,##0", width: 13,
        note: dc.irrAllIntervals ? "POA integrated over all intervals of the day" : "POA integrated over the valid intervals of the day",
        values: days.map((d) => day3.reduce((a, dd, i) => a + (dd === d && (dc.irrAllIntervals || ok(i)) && isNum(poaV[i]) ? (poaV[i] as number) : 0), 0) * plan.stepH),
        f: (r) => (!poa ? "0" : dc.irrAllIntervals
            ? `SUMIFS(${s3.xr(poa)},${s3.xr("Day")},${D(r)})*Step_h`
            : `SUMIFS(${s3.xr(poa)},${s3.xr("Day")},${D(r)},${s3.xr(plan.comply)},1)*Step_h`),
    });
    if (useInterp) {
        sd.add({
            id: "Interp", header: "Interpolated / valid", kind: "formula", group: "crit", numFmt: "0.0%", width: 11,
            values: days.map((d) => {
                const v = day3.filter((dd, i) => dd === d && ok(i));
                const n = day3.filter((dd, i) => dd === d && ok(i) && interp[i] === 1).length;
                return v.length ? n / v.length : 0;
            }),
            f: (r) => `IFERROR(COUNTIFS(${s3.xr("Day")},${D(r)},${s3.xr(plan.comply)},1,${s3.xr(plan.interpCol!)},1)/COUNTIFS(${s3.xr("Day")},${D(r)},${s3.xr(plan.comply)},1),0)`,
        });
    }
    sd.add({
        id: "Excl", header: "Excluded by hand (whole day)", kind: "formula", group: "crit", numFmt: "0", width: 10,
        note: "1 when a period of the Exclusions table covers the whole day",
        values: days.map((d) => (periods.some((p) => p.a <= d * 1440 && p.b >= (d + 1) * 1440) ? 1 : 0)),
        f: (r) => `IF(COUNTIFS(Excl_From,"<="&(${D(r)}+0.000001),Excl_To,">="&(${D(r)}+1-0.000001))>0,1,0)`,
    });
    const base = sd.get(baseCol).values as number[];
    const H = sd.get("Hours").values as number[], Irr = sd.get("Irr").values as number[];
    const Ip = useInterp ? (sd.get("Interp").values as number[]) : [];
    const Ex = sd.get("Excl").values as number[];
    const validV: number[] = days.map((_, i) =>
        base[i] > 0 && (dc.minHours === 0 || H[i] >= dc.minHours) && (dc.minDailyWh === 0 || Irr[i] > dc.minDailyWh) && (!useInterp || Ip[i] <= dc.maxInterpPct) && Ex[i] === 0 ? 1 : 0);
    sd.add({
        id: "Valid", header: "Valid day", kind: "formula", group: "result", numFmt: "0", width: 8, values: validV,
        f: (r) => `IF(AND(${sd.c(baseCol, r)}>0,OR(Day_Min_Hours=0,${sd.c("Hours", r)}>=Day_Min_Hours),OR(Day_Min_Wh=0,${sd.c("Irr", r)}>Day_Min_Wh)${useInterp ? `,${sd.c("Interp", r)}<=Max_Interp_Pct` : ""},${sd.c("Excl", r)}=0),1,0)`,
    });
    const first = days.length ? Math.min(...days) : 0;
    const win: number[] = days.map((d) => (dc.maxWindow === 0 || d - first < dc.maxWindow ? 1 : 0));
    sd.add({ id: "Win", header: "In test window", kind: "formula", group: "crit", numFmt: "0", width: 9, values: win, f: (r) => `IF(Max_Window_Days=0,1,IF(${D(r)}-MIN(${sd.range("Day")})<Max_Window_Days,1,0))` });
    let run = 0;
    const selN: number[] = days.map((_, i) => {
        if (validV[i] === 1 && win[i] === 1) run++;
        return validV[i] === 1 && win[i] === 1 && (dc.required === 0 || run <= dc.required) ? 1 : 0;
    });
    sd.add({
        id: "SelN", header: "First N valid days", kind: "formula", group: "crit", numFmt: "0", width: 9, values: selN,
        f: (r) => `IF(AND(${sd.c("Valid", r)}=1,${sd.c("Win", r)}=1,OR(Required_Days=0,COUNTIFS($${sd.L("Valid")}$2:${sd.L("Valid")}${r},1,$${sd.L("Win")}$2:${sd.L("Win")}${r},1)<=Required_Days)),1,0)`,
    });
    const elig: number[] = days.map((_, i) => (base[i] > 0 && Ex[i] === 0 && win[i] === 1 ? 1 : 0));
    sd.add({ id: "Elig", header: "Fallback candidate", kind: "formula", group: "crit", numFmt: "0", width: 9, values: elig, f: (r) => `IF(AND(${sd.c(baseCol, r)}>0,${sd.c("Excl", r)}=0,${sd.c("Win", r)}=1),1,0)` });
    const rank: Val[] = days.map((_, i) => {
        if (elig[i] !== 1) return "";
        let k = 1;
        days.forEach((__, j) => { if (elig[j] === 1 && (Irr[j] > Irr[i] || (j < i && Irr[j] === Irr[i]))) k++; });
        return k;
    });
    sd.add({
        id: "Rank", header: "Irradiation rank", kind: "formula", group: "crit", numFmt: "0", width: 9, values: rank,
        f: (r) => {
            const e = sd.L("Elig"), ir = sd.L("Irr");
            return `IF(${sd.c("Elig", r)}=1,COUNTIFS(${sd.range("Elig")},1,${sd.range("Irr")},">"&${sd.c("Irr", r)})+COUNTIFS($${e}$1:${e}${r - 1},1,$${ir}$1:${ir}${r - 1},${sd.c("Irr", r)})+1,"")`;
        },
    });
    const nSelN = selN.reduce((a, b) => a + b, 0);
    const span = days.length ? Math.max(...days) - first + 1 : 0;
    const fallbackActive = dc.fallbackTopK > 0 && dc.required > 0 && nSelN < dc.required && dc.maxWindow > 0 && span >= dc.maxWindow;
    const sel: number[] = days.map((_, i) => (fallbackActive ? (elig[i] === 1 && (rank[i] as number) <= dc.fallbackTopK ? 1 : 0) : selN[i]));
    sd.add({
        id: "Sel", header: "Day used in the test", kind: "formula", group: "result", numFmt: "0", width: 9, values: sel,
        note: "First N valid days within the window; with the fallback active, the K eligible days with the highest irradiation",
        f: (r) => `IF(Fallback_Active=1,IF(AND(${sd.c("Elig", r)}=1,N(${sd.c("Rank", r)})<=Fallback_Days),1,0),${sd.c("SelN", r)})`,
    });
    const daysSelected = sel.reduce((a, b) => a + b, 0);
    const daysNeeded = fallbackActive ? dc.fallbackTopK : dc.required;
    return {
        valid: validV, selected: sel, fallbackActive, daysSelected, daysNeeded,
        complete: daysNeeded === 0 || daysSelected >= daysNeeded,
        validDays: validV.reduce((a, b) => a + b, 0), windowDays: span,
    };
}

/** Formulas for the summary cells that go with addDaySelection. */
export function daySummaryFormulas(sd: ColumnSheet) {
    return {
        fallbackActive: `IF(AND(Fallback_Days>0,Required_Days>0,SUM(${sd.xr("SelN")})<Required_Days,Max_Window_Days>0,MAX(${sd.xr("Day")})-MIN(${sd.xr("Day")})+1>=Max_Window_Days),1,0)`,
        daysSelected: `SUM(${sd.xr("Sel")})`,
        daysNeeded: `IF(Fallback_Active=1,Fallback_Days,Required_Days)`,
        validDays: `SUM(${sd.xr("Valid")})`,
    };
}
