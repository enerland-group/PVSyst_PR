//-----------------------------------------------------------------------
// Workbook writer (exceljs). Every calculated cell is written as a live
// formula together with its cached result, so the file shows correct numbers
// even in viewers that do not recalculate, and Excel recalculates on open.
// No Power Query, no macros. The client version drops internal columns
// (Problematic_Flag), the sensor map and the hidden configuration.
//-----------------------------------------------------------------------

import type ExcelJSNS from "exceljs";
import { q, type ColumnSheet, type Col, type Plan } from "./engine";
import { tr } from "./i18n";
import type { EpiResults, PrResults } from "./results";
import { daySummaryFormulas, type DaySelection } from "./days";
import type { ImportStats } from "./import";
import { workbookNameFor } from "./params";
import { isoDateTimeToMin } from "./parse";
import { addCharts, type ChartSpec, type ChartSeries } from "./xlsx-charts";
import type { ModelConfig } from "./types";

export interface Artifacts {
    plan: Plan;
    meteo?: ColumnSheet;
    epi?: EpiResults;
    pr?: PrResults;
    stats?: ImportStats;
    sources?: { scada: string[]; meter: string[]; pvsyst: string };
}

type WS = ExcelJSNS.Worksheet;
type WB = ExcelJSNS.Workbook;

const NAVY = "FF0D2444", WHITE = "FFFFFFFF";
const FILL: Record<string, { bg: string; fg: string }> = {
    time: { bg: NAVY, fg: WHITE },
    data: { bg: "FFD9D9D9", fg: "FF262626" },
    filter: { bg: "FF1D6F42", fg: WHITE },
    crit: { bg: "FFF4B183", fg: "FF262626" },
    result: { bg: "FFED7D31", fg: WHITE },
    manual: { bg: "FFFFE699", fg: "FF262626" },
    internal: { bg: "FFBFBFBF", fg: "FF595959" },
};
const solid = (argb: string): ExcelJSNS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const thin: Partial<ExcelJSNS.Borders> = { bottom: { style: "thin", color: { argb: "FFBFBFBF" } } };

export const CONFIG_SHEET = "_config";
export const CONFIG_MARK = "PERFORMANCE_MODEL_CONFIG v1";

function writeColumnSheet(wb: WB, s: ColumnSheet, client: boolean, tabColor: string, cache = true): WS {
    const ws = wb.addWorksheet(s.name, { properties: { tabColor: { argb: tabColor } }, views: [{ state: "frozen", xSplit: 1, ySplit: 1 }] });
    const cols = s.cols.filter((c) => !(client && c.kind === "internal"));
    cols.forEach((c, j) => {
        const cell = ws.getCell(1, j + 1);
        cell.value = c.header;
        const st = FILL[c.kind === "manual" ? "manual" : c.kind === "internal" ? "internal" : c.group];
        cell.fill = solid(st.bg);
        cell.font = { bold: true, color: { argb: st.fg }, size: 10 };
        cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
        if (c.note) cell.note = c.note;
        ws.getColumn(j + 1).width = c.width ?? 12;
        if (c.numFmt) ws.getColumn(j + 1).numFmt = c.numFmt;
    });
    ws.getRow(1).height = 42;
    for (let i = 0; i < s.n; i++) {
        const r = i + 2;
        const row = ws.getRow(r);
        cols.forEach((c, j) => {
            const v = c.values[i];
            const cell = row.getCell(j + 1);
            if (c.f) {
                const res = v === null || v === undefined ? "" : v;
                cell.value = (cache ? { formula: c.f(r), result: res } : { formula: c.f(r) }) as ExcelJSNS.CellFormulaValue;
            } else if (v !== null && v !== undefined && v !== "") {
                cell.value = v as number | string;
            }
            if (c.kind === "manual") cell.fill = solid("FFFFF2CC");
        });
    }
    if (s.n > 0 && cols.length) {
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: s.n + 1, column: cols.length } };
        // Highlight filtered-out readings and failed criteria
        const last = s.n + 1;
        cols.forEach((c, j) => {
            const L = colLetter(j);
            const ref = `${L}2:${L}${last}`;
            if (c.group === "filter") {
                ws.addConditionalFormatting({ ref, rules: [
                    { type: "containsText", operator: "containsText", text: "Outlier", priority: 1, style: { fill: solid("FFF8CBAD"), font: { color: { argb: "FF9C0006" } } } },
                    { type: "containsText", operator: "containsText", text: "Discard", priority: 2, style: { fill: solid("FFFFC7CE"), font: { color: { argb: "FF9C0006" } } } },
                ] });
            }
            if (c.group === "crit" || c.id === "Comply with all criteria?" || c.id === "Valid") {
                ws.addConditionalFormatting({ ref, rules: [
                    { type: "cellIs", operator: "equal", formulae: ["0"], priority: 3, style: { fill: solid("FFFFC7CE"), font: { color: { argb: "FF9C0006" } } } },
                ] });
            }
        });
    }
    return ws;
}
function colLetter(i: number) { let s = "", n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

function writeInputs(wb: WB, plan: Plan, cfg: ModelConfig, sheetName: string) {
    const ws = wb.addWorksheet(sheetName, { properties: { tabColor: { argb: "FF4472C4" } } });
    ws.columns = [{ width: 18 }, { width: 22 }, { width: 17 }, { width: 22 }, { width: 70 }, { width: 40 }];
    ws.getCell("A1").value = `${cfg.project.name} — ${cfg.type === "EPI" ? "EPI test inputs" : "PR test inputs"}`;
    ws.getCell("A1").font = { bold: true, size: 14, color: { argb: NAVY } };
    ws.getCell("A2").value = "Every threshold used by the formulas lives here as a named cell. Change a value and the whole workbook recalculates.";
    ws.getCell("A2").font = { italic: true, color: { argb: "FF595959" } };
    const head = ["Group", "Name", "Value", "Unit", "Description"];
    head.forEach((h, j) => { const c = ws.getCell(4, j + 1); c.value = h; c.fill = solid(NAVY); c.font = { bold: true, color: { argb: WHITE } }; });
    let r = 5;
    const scalars = plan.inputs.filter((i) => !Array.isArray(i.value));
    for (const inp of scalars) {
        ws.getCell(r, 1).value = inp.group;
        ws.getCell(r, 2).value = inp.name;
        const v = ws.getCell(r, 3);
        v.value = inp.value as number;
        v.fill = solid("FFDDEBF7");
        v.font = { bold: true, color: { argb: "FF1F4E79" } };
        ws.getCell(r, 4).value = inp.unit;
        ws.getCell(r, 5).value = inp.note ? `${inp.label} (${inp.note})` : inp.label;
        [1, 2, 3, 4, 5].forEach((j) => (ws.getCell(r, j).border = thin));
        wb.definedNames.add(`${q(sheetName)}!$C$${r}`, inp.name);
        r++;
    }
    const arrays = plan.inputs.filter((i) => Array.isArray(i.value));
    if (arrays.length) {
        r += 1;
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        ws.getCell(r, 1).value = "Month";
        arrays.forEach((a, k) => { ws.getCell(r, 2 + k).value = a.name; });
        [1, 2, 3].forEach((j) => { const c = ws.getCell(r, j); c.fill = solid(NAVY); c.font = { bold: true, color: { argb: WHITE } }; });
        const r0 = r + 1;
        months.forEach((m, i) => {
            ws.getCell(r0 + i, 1).value = m;
            arrays.forEach((a, k) => {
                const c = ws.getCell(r0 + i, 2 + k);
                c.value = (a.value as number[])[i];
                c.fill = solid("FFDDEBF7");
                c.numFmt = a.name === "PR_Design_Month" ? "0.0%" : "0.00";
            });
        });
        arrays.forEach((a, k) => {
            const L = colLetter(1 + k);
            wb.definedNames.add(`${q(sheetName)}!$${L}$${r0}:$${L}$${r0 + 11}`, a.name);
            ws.getCell(r0 + 12, 2 + k).value = a.label;
            ws.getCell(r0 + 12, 2 + k).font = { italic: true, size: 9, color: { argb: "FF595959" } };
        });
    }
    // Periods excluded by hand (events not attributable to the contractor): named ranges Excl_From / Excl_To
    {
        let r2 = ws.rowCount + 2;
        const head = ["Excluded periods", "From", "To", "Cause", "Detailed reason", "Evidence / reference"];
        head.forEach((h, j) => { const c = ws.getCell(r2, 1 + j); c.value = h; c.fill = solid(NAVY); c.font = { bold: true, color: { argb: WHITE } }; });
        const list = cfg.days.excluded
            .map((e) => ({ e, a: isoDateTimeToMin(e.from), b: isoDateTimeToMin(e.to) }))
            .filter((x) => x.a !== null && x.b !== null);
        const r0 = r2 + 1;
        const n = list.length + 10; // spare rows so periods can be added in Excel
        for (let k = 0; k < n; k++) {
            const x = list[k];
            const cells = [2, 3, 4, 5, 6].map((j) => ws.getCell(r0 + k, j));
            if (x) {
                cells[0].value = x.a! / 1440; cells[1].value = x.b! / 1440;
                cells[2].value = x.e.cause; cells[3].value = x.e.reason; cells[4].value = x.e.evidence;
            }
            cells[0].numFmt = cells[1].numFmt = "dd/mm/yyyy hh:mm";
            cells.forEach((c) => { c.fill = solid("FFFFF2CC"); c.alignment = { vertical: "top", wrapText: true }; });
        }
        wb.definedNames.add(`${q(sheetName)}!$B$${r0}:$B$${r0 + n - 1}`, "Excl_From");
        wb.definedNames.add(`${q(sheetName)}!$C$${r0}:$C$${r0 + n - 1}`, "Excl_To");
        r2 = r0 + n;
        ws.getCell(r2, 2).value = "Yellow cells can be edited in Excel. An interval is excluded when From < its timestamp ≤ To; a day covered from 00:00 to 24:00 is excluded as a whole.";
        ws.getCell(r2, 2).font = { italic: true, size: 9, color: { argb: "FF595959" } };
    }
}

function writeSensorMap(wb: WB, cfg: ModelConfig, name: string) {
    const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: "FF4472C4" } } });
    ws.columns = [{ header: "SCADA column", width: 70 }, { header: "Parameter", width: 14 }, { header: "Workbook column", width: 22 }];
    ws.getRow(1).eachCell((c) => { c.fill = solid(NAVY); c.font = { bold: true, color: { argb: WHITE } }; });
    cfg.mapping.forEach((m, i) => ws.addRow([m.raw, m.param ?? "— ignored —", workbookNameFor(cfg.mapping, i)]));
}

function pushDayLines(lines: Line[], sd: ColumnSheet, sel: DaySelection, es: boolean) {
    const f = daySummaryFormulas(sd);
    lines.push({ label: es ? "Días válidos" : "Valid days", formula: f.validDays, result: sel.validDays, fmt: "0", name: "Valid_Days" });
    lines.push({ label: es ? "Alternativa por irradiación activa (0/1)" : "Highest-irradiation fallback active (0/1)", formula: f.fallbackActive, result: sel.fallbackActive ? 1 : 0, fmt: "0", name: "Fallback_Active" });
    lines.push({ label: es ? "Días necesarios" : "Days needed", formula: f.daysNeeded, result: sel.daysNeeded, fmt: "0", name: "Days_Needed" });
    lines.push({ label: es ? "Días usados en la prueba" : "Days used in the test", formula: f.daysSelected, result: sel.daysSelected, fmt: "0", name: "Days_Used", bold: true });
}

interface Line { label: string; formula?: string; value?: number | string; result?: number | string; name?: string; fmt?: string; internal?: boolean; bold?: boolean; unit?: string }

function writeSummary(ws: WS, wb: WB, a: Artifacts, client: boolean) {
    const { plan } = a;
    const cfg = plan.cfg;
    const L = tr(cfg.project.lang);
    const es = cfg.project.lang === "ES";
    const s3 = plan.sheet;
    ws.columns = [{ width: 44 }, { width: 22 }, { width: 12 }, { width: 60 }];
    ws.getCell("A1").value = cfg.project.name || "Performance test";
    ws.getCell("A1").font = { bold: true, size: 18, color: { argb: NAVY } };
    ws.getCell("A2").value = cfg.type === "EPI" ? "Energy Performance Index test — IEC 61724-3" : (es ? "Cálculo Performance Ratio — IEC 61724-1" : "Performance Ratio test — IEC 61724-1");
    ws.getCell("A2").font = { size: 11, color: { argb: "FF2E6AB5" } };
    ws.getCell("A3").value = [cfg.project.code, cfg.project.client, cfg.project.contractRef].filter(Boolean).join(" · ");
    const lines: Line[] = [];
    const step = (name: string) => plan.I[name];

    if (cfg.type === "EPI") {
        const e = a.epi;
        lines.push({ label: es ? "Intervalos SCADA" : "SCADA intervals", formula: `COUNT(${s3.xr("Date")})`, result: plan.ds.t.length, fmt: "0" });
        lines.push({ label: es ? "Intervalos válidos (todos los criterios)" : "Valid intervals (all criteria)", formula: `SUM(${s3.xr(plan.comply)})`, result: (s3.get(plan.comply).values as number[]).reduce((x, y) => x + y, 0), fmt: "0", name: "Valid_Intervals" });
        if (plan.aggHelper) lines.push({ label: es ? "Horas válidas agregadas (criterio de horas)" : "Aggregated valid hours (hours criterion)", formula: `SUM(${s3.xr(plan.aggHelper)})*Step_h`, result: plan.aggValidHours, fmt: "0.00", name: "Agg_Valid_Hours", unit: "h" });
        if (e) {
            const c6 = e.comp, c7 = e.daily;
            const k = e.kpi;
            lines.push({ label: "", value: "" });
            pushDayLines(lines, c7, e.days, es);
            lines.push({ label: es ? "Primer intervalo comparado" : "First compared step", formula: `MIN(${c6.xr("Date")})`, result: k.first ?? "", fmt: "dd/mm/yyyy hh:mm" });
            lines.push({ label: es ? "Último intervalo comparado" : "Last compared step", formula: `MAX(${c6.xr("Date")})`, result: k.last ?? "", fmt: "dd/mm/yyyy hh:mm" });
            lines.push({ label: es ? "Pasos contados (válidos, en días usados)" : "Counted steps (valid, on days used)", formula: `SUM(${c6.xr("Cnt")})`, result: k.validIntervals, fmt: "0" });
            lines.push({ label: es ? "Producción esperada PVsyst" : "Expected production PVsyst", formula: `SUM(${c6.xr("VExp")})*Bucket_h`, result: k.expectedKwh, fmt: "#,##0", unit: "kWh", name: "Expected_kWh" });
            lines.push({ label: es ? "Producción garantizada" : "Guaranteed production", formula: `SUM(${c6.xr("VGuar")})*Bucket_h`, result: k.guaranteedKwh, fmt: "#,##0", unit: "kWh", name: "Guaranteed_kWh", bold: true });
            if (c6.has("VMeas")) {
                lines.push({ label: es ? "Producción medida neta" : "Measured net production", formula: `SUM(${c6.xr("VMeas")})*Bucket_h`, result: k.measuredKwh, fmt: "#,##0", unit: "kWh", name: "Measured_kWh", bold: true });
                lines.push({ label: es ? "Desviación medida vs garantizada" : "Deviation measured vs guaranteed", formula: `IFERROR(Measured_kWh/Guaranteed_kWh-1,"")`, result: k.deviation ?? "", fmt: "0.00%", name: "Deviation", bold: true });
                lines.push({ label: es ? "EPI medido (medida / esperada)" : "Measured EPI (measured / expected)", formula: `IFERROR(Measured_kWh/Expected_kWh,"")`, result: k.epiMeasured ?? "", fmt: "0.0000", name: "EPI_Measured", bold: true });
                lines.push({ label: es ? "EPI garantizado (× degradación × disponibilidad)" : "Guaranteed EPI (× degradation × availability)", formula: `Guaranteed_EPI*Degradation*Availability`, result: cfg.epi.guaranteedEpi * cfg.epi.degradation * cfg.epi.availability, fmt: "0.0000" });
                lines.push({ label: es ? "Resultado" : "Result", formula: `IF(Days_Used<Days_Needed,"${L.incomplete}",IF(Measured_kWh>=Guaranteed_kWh,"${L.passPr}","${L.failPr}"))`, result: !e.days.complete ? L.incomplete : k.pass ? L.passPr : L.failPr, bold: true, name: "Verdict" });
            }
        } else {
            lines.push({ label: "", value: "" });
            lines.push({ label: es ? "Etapa" : "Stage", value: es ? "Etapa 1: meteo medida lista para PVsyst. Añade los resultados de PVsyst y el contador en la app para completar la comparación." : "Stage 1: measured meteo ready for PVsyst. Add the PVsyst results and the meter in the app to complete the comparison." });
        }
    } else if (a.pr) {
        const d = a.pr.daily, k = a.pr.kpi;
        lines.push({ label: es ? "Primer día" : "First day", formula: `MIN(${d.xr("Day")})`, result: (d.get("Day").values as number[])[0], fmt: "dd/mm/yyyy" });
        lines.push({ label: es ? "Último día" : "Last day", formula: `MAX(${d.xr("Day")})`, result: (d.get("Day").values as number[])[d.n - 1], fmt: "dd/mm/yyyy" });
        lines.push({ label: es ? "Días con datos" : "Days with data", formula: `COUNT(${d.xr("Day")})`, result: k.days, fmt: "0" });
        pushDayLines(lines, d, a.pr.days, es);
        lines.push({ label: es ? "PR de diseño × FT (ponderado por días usados)" : "Design PR × FT (weighted by days used)", formula: `IFERROR(SUMPRODUCT(${d.xr("PRd")},${d.xr("Sel")})/SUM(${d.xr("Sel")}),0)`, result: k.prGuaranteed, fmt: "0.00%", name: "PR_Guaranteed", bold: true });
        lines.push({ label: es ? "PR medido — ΣE / ΣPR' (IEC 61724-1)" : "Measured PR — ΣE / ΣPR' (IEC 61724-1)", formula: `IFERROR(SUMPRODUCT(${d.xr("E")},${d.xr("Sel")})/SUMPRODUCT(${d.xr("R")},${d.xr("Sel")}),0)`, result: k.prWeighted, fmt: "0.00%", name: "PR_Weighted" });
        lines.push({ label: es ? "PR medido — media de PR diarios" : "Measured PR — mean of daily PR", formula: `IFERROR(SUMPRODUCT(${d.xr("PRp")},${d.xr("Sel")})/SUM(${d.xr("Sel")}),0)`, result: k.prMean, fmt: "0.00%", name: "PR_Mean" });
        lines.push({ label: es ? "PR medido (método del contrato)" : "Measured PR (contract method)", formula: cfg.pr.overall === "weighted" ? "PR_Weighted" : "PR_Mean", result: k.prReal, fmt: "0.00%", name: "PR_Real", bold: true });
        lines.push({ label: es ? "Diferencia %" : "Difference %", formula: `IFERROR((PR_Real-PR_Guaranteed)/PR_Guaranteed,"")`, result: k.deviation, fmt: "0.00%", bold: true });
        if (plan.final.ALB && cfg.pr.albedoBase > 0) {
            const dev = k.albedo !== null ? k.albedo / cfg.pr.albedoBase - 1 : null;
            lines.push({ label: es ? "Albedo medido (intervalos válidos, días usados)" : "Measured albedo (valid intervals, days used)", formula: `IFERROR(SUMPRODUCT(${d.xr("AlbS")},${d.xr("Sel")})/SUMPRODUCT(${d.xr("AlbN")},${d.xr("Sel")}),"")`, result: k.albedo ?? "", fmt: "0.000", name: "Albedo_Measured" });
            lines.push({ label: es ? "Desviación del albedo vs modelo" : "Albedo deviation vs model", formula: `IFERROR(Albedo_Measured/Albedo_Base-1,"")`, result: dev ?? "", fmt: "0.0%", name: "Albedo_Deviation" });
            lines.push({ label: es ? "¿Recalcular PR de diseño con el albedo medido?" : "Recalculate the design PR with the measured albedo?", formula: `IF(Albedo_Deviation="","",IF(ABS(Albedo_Deviation)>Albedo_Tol,"${es ? "SÍ — desviación mayor que la tolerancia" : "YES — deviation above the tolerance"}","${es ? "No" : "No"}"))`, result: dev === null ? "" : Math.abs(dev) > cfg.pr.albedoTol ? (es ? "SÍ — desviación mayor que la tolerancia" : "YES — deviation above the tolerance") : "No" });
        }
        lines.push({ label: es ? "Resultado" : "Result", formula: `IF(Days_Used<Days_Needed,"${L.incomplete}",IF(PR_Real>=PR_Guaranteed,"${L.passPr}","${L.failPr}"))`, result: !a.pr.days.complete ? L.incomplete : k.pass ? L.passPr : L.failPr, bold: true, name: "Verdict" });
    }

    // Internal QC counts
    const flag = s3.xr("Problematic_Flag");
    const fl = s3.get("Problematic_Flag").values as string[];
    const cnt = (pat: RegExp) => fl.filter((x) => pat.test(x)).length;
    lines.push({ label: "", value: "", internal: true });
    lines.push({ label: es ? "Control de calidad (interno)" : "Data quality (internal)", value: "", internal: true, bold: true });
    lines.push({ label: es ? "Intervalos con incidencias" : "Intervals with incidences", formula: `COUNTIF(${flag},"<>OK")`, result: fl.filter((x) => x !== "OK").length, fmt: "0", internal: true });
    lines.push({ label: es ? "Datos ausentes" : "Missing data", formula: `COUNTIF(${flag},"*Missing data*")`, result: cnt(/Missing data/), fmt: "0", internal: true });
    lines.push({ label: es ? "Valores sustituidos (irradiancia < mínimo → 0)" : "Replaced values (irradiance < minimum → 0)", formula: `COUNTIF(${flag},"*Replaced value*")`, result: cnt(/Replaced value/), fmt: "0", internal: true });
    lines.push({ label: es ? "Fuera de límites" : "Outside limits", formula: `COUNTIF(${flag},"*Exceedance*")`, result: cnt(/Exceedance/), fmt: "0", internal: true });
    if (cfg.qc.deadAbrupt) {
        lines.push({ label: es ? "Sensor congelado" : "Dead sensor", formula: `COUNTIF(${flag},"*Dead*")`, result: cnt(/Dead/), fmt: "0", internal: true });
        lines.push({ label: es ? "Cambio brusco" : "Abrupt change", formula: `COUNTIF(${flag},"*Abrupt*")`, result: cnt(/Abrupt/), fmt: "0", internal: true });
    }
    if (a.sources && !client) {
        lines.push({ label: es ? "Ficheros SCADA" : "SCADA files", value: a.sources.scada.join(", "), internal: true });
        if (a.sources.meter.length) lines.push({ label: es ? "Ficheros contador" : "Meter files", value: a.sources.meter.join(", "), internal: true });
        if (a.sources.pvsyst) lines.push({ label: "PVsyst", value: a.sources.pvsyst, internal: true });
    }

    let r = 5;
    for (const ln of lines) {
        if (client && ln.internal) continue;
        ws.getCell(r, 1).value = ln.label;
        const c = ws.getCell(r, 2);
        if (ln.formula) c.value = { formula: ln.formula, result: ln.result ?? "" } as ExcelJSNS.CellFormulaValue;
        else if (ln.value !== undefined) c.value = ln.value;
        if (ln.fmt) c.numFmt = ln.fmt;
        if (ln.unit) ws.getCell(r, 3).value = ln.unit;
        if (ln.bold) { ws.getCell(r, 1).font = { bold: true }; c.font = { bold: true, color: { argb: NAVY } }; }
        if (ln.label) { ws.getCell(r, 1).border = thin; c.border = thin; }
        if (ln.name) {
            wb.definedNames.add(`${q(ws.name)}!$B$${r}`, ln.name);
            if (ln.name === "Verdict") {
                ws.mergeCells(r, 2, r, 4);
                c.alignment = { wrapText: true, vertical: "middle" };
                ws.getRow(r).height = 32;
                ws.addConditionalFormatting({ ref: `B${r}`, rules: [
                    { type: "containsText", operator: "containsText", text: "NOT", priority: 1, style: { fill: solid("FFFFC7CE"), font: { bold: true, color: { argb: "FF9C0006" } } } },
                    { type: "containsText", operator: "containsText", text: "NO ha", priority: 2, style: { fill: solid("FFFFC7CE"), font: { bold: true, color: { argb: "FF9C0006" } } } },
                ] });
            }
        }
        r++;
    }
    void step;
    r += 1;
    ws.getCell(r, 1).value = es ? "Colores: azul = inputs · gris = valores importados · verde = fórmulas · naranja = resultados · amarillo = editable a mano" : "Colours: blue = inputs · grey = imported values · green = formulas · orange = results · yellow = edit by hand";
    ws.getCell(r, 1).font = { italic: true, size: 9, color: { argb: "FF595959" } };
    ws.getCell(r + 1, 1).value = `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · PR-EPI Controller · Model builder`;
    ws.getCell(r + 1, 1).font = { italic: true, size: 9, color: { argb: "FF595959" } };
}

function writeConfig(wb: WB, cfg: ModelConfig, a: Artifacts) {
    const ws = wb.addWorksheet(CONFIG_SHEET, { state: "veryHidden" });
    const json = JSON.stringify({ config: cfg, sources: a.sources ?? null, stats: a.stats ?? null, stage: a.epi ? 2 : 1, savedAt: new Date().toISOString() });
    ws.getCell("A1").value = CONFIG_MARK;
    const chunk = 30000;
    for (let i = 0, r = 2; i < json.length; i += chunk, r++) ws.getCell(r, 1).value = json.slice(i, i + chunk);
}

export async function buildWorkbook(a: Artifacts, opts: { client: boolean; cache?: boolean }): Promise<ArrayBuffer> {
    const cache = opts.cache ?? true;
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = "PR-EPI Controller";
    wb.created = new Date();
    wb.calcProperties.fullCalcOnLoad = true;
    const { plan } = a;
    const cfg = plan.cfg;
    const L = tr(cfg.project.lang);
    const summary = wb.addWorksheet(L.sSummary, { properties: { tabColor: { argb: "FFED7D31" } } });
    const charts = wb.addWorksheet(L.sCharts, { properties: { tabColor: { argb: "FFED7D31" } } });
    writeInputs(wb, plan, cfg, L.sInputs);
    if (!opts.client) writeSensorMap(wb, cfg, L.sMap);
    writeColumnSheet(wb, plan.sheet, opts.client, "FF1D6F42", cache);
    if (cfg.type === "EPI") {
        if (a.meteo) writeColumnSheet(wb, a.meteo, opts.client, "FF1D6F42", cache);
        if (a.epi) {
            writeColumnSheet(wb, a.epi.pvsyst, opts.client, "FFA5A5A5", cache);
            if (a.epi.meter) writeColumnSheet(wb, a.epi.meter, opts.client, "FFA5A5A5", cache);
            writeColumnSheet(wb, a.epi.comp, opts.client, "FF1D6F42", cache);
            writeColumnSheet(wb, a.epi.daily, opts.client, "FFED7D31", cache);
        }
    } else if (a.pr) {
        writeColumnSheet(wb, a.pr.daily, opts.client, "FFED7D31", cache);
    }
    writeSummary(summary, wb, a, opts.client);
    if (!opts.client) writeConfig(wb, cfg, a);
    const specs = chartSpecs(a, opts.client, L.sSummary, L.sCharts, cfg.project.lang === "ES");
    charts.getCell("A1").value = cfg.project.name ? `${cfg.project.name} — ${cfg.project.lang === "ES" ? "gráficos" : "charts"}` : "Charts";
    charts.getCell("A1").font = { bold: true, size: 16, color: { argb: NAVY } };
    charts.getCell("A2").value = cfg.project.lang === "ES" ? "Los gráficos leen las hojas del libro: se actualizan al cambiar cualquier valor de 01 Inputs." : "The charts read the sheets of this workbook: they update when any value in 01 Inputs changes.";
    charts.getCell("A2").font = { italic: true, size: 9, color: { argb: "FF595959" } };
    const out = await wb.xlsx.writeBuffer();
    return await addCharts(out as ArrayBuffer, specs);
}

export function workbookFileName(cfg: ModelConfig, tag: string, client: boolean): string {
    const code = (cfg.project.code || cfg.project.name || "Project").replace(/[^\w.-]+/g, "_");
    return `${code}-${cfg.type}_Model_${tag}${client ? "_Client" : ""}.xlsx`;
}

/** Re-open a workbook generated by the app (internal version). */
export async function readModelWorkbook(buf: ArrayBuffer): Promise<{ config: ModelConfig; sources: Artifacts["sources"] | null; dataSheet: { headers: string[]; rows: (number | string | null)[][] } }> {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const cs = wb.getWorksheet(CONFIG_SHEET);
    if (!cs || cs.getCell("A1").value !== CONFIG_MARK) throw new Error("This workbook was not generated by the model builder (or it is a client version, which has no configuration). Open the internal version.");
    let json = "";
    for (let r = 2; ; r++) { const v = cs.getCell(r, 1).value; if (v === null || v === undefined || v === "") break; json += String(v); }
    const parsed = JSON.parse(json);
    const config = parsed.config as ModelConfig;
    const L = tr(config.project.lang);
    const ds = wb.getWorksheet(config.type === "EPI" ? L.sData : L.sDataPR);
    if (!ds) throw new Error("The data sheet is missing from the workbook.");
    const headers: string[] = [];
    ds.getRow(1).eachCell({ includeEmpty: true }, (c, col) => (headers[col - 1] = String(c.value ?? "")));
    const rows: (number | string | null)[][] = [];
    ds.eachRow((row, rn) => {
        if (rn === 1) return;
        const vals = headers.map((_, j) => {
            const v = row.getCell(j + 1).value as unknown;
            if (v === null || v === undefined) return null;
            if (v instanceof Date) return Math.round((v.getTime() / 864e5 + 25569) * 1440) / 1440;
            if (typeof v === "object" && v && "result" in (v as object)) {
                const res = (v as { result: unknown }).result;
                if (res instanceof Date) return Math.round((res.getTime() / 864e5 + 25569) * 1440) / 1440;
                return (res as number | string | null) ?? null;
            }
            return v as number | string;
        });
        rows.push(vals);
    });
    return { config, sources: parsed.sources, dataSheet: { headers, rows } };
}

export type { Col };

// ── Charts ─────────────────────────────────────────────────────────────
const C = { meas: "1B3D6E", exp: "E8740C", expBar: "F2B27A", guar: "9AA5B1", sensors: ["0F6CBD", "E8740C", "2A9D8F", "8A4FBF", "C2407A", "6B8E23", "8C6D1F", "4F6D8A"] };

/** Range of a column as written (client workbooks leave out internal columns). */
function colRange(s: ColumnSheet, id: string, client: boolean): string | null {
    const cols = s.cols.filter((c) => !(client && c.kind === "internal"));
    const j = cols.findIndex((c) => c.id === id);
    if (j < 0 || s.n === 0) return null;
    const L = colLetter(j);
    return `${q(s.name)}!$${L}$2:$${L}$${s.n + 1}`;
}

function chartSpecs(a: Artifacts, client: boolean, summary: string, chartsSheet: string, es: boolean): ChartSpec[] {
    const { plan } = a;
    const cfg = plan.cfg;
    const out: ChartSpec[] = [];
    const s3 = plan.sheet;
    let slot = 0;
    const next = (): Pick<ChartSpec, "sheet" | "from" | "to"> => { const r0 = 3 + slot++ * 22; return { sheet: chartsSheet, from: { col: 0, row: r0 }, to: { col: 14, row: r0 + 21 } }; };
    const r = (s: ColumnSheet, id: string) => colRange(s, id, client);
    // x: undefined for bar charts; null means "the x range is missing" → no series
    const ser = (name: string, s: ColumnSheet, id: string, x: string | null | undefined, color: string, extra: Partial<ChartSeries> = {}): ChartSeries | null => {
        const y = r(s, id);
        return y && x !== null ? { name, y, x: x ?? undefined, color, ...extra } : null;
    };
    const ok = (l: (ChartSeries | null)[]) => l.filter((x): x is ChartSeries => x !== null);
    const x3 = r(s3, "Date");

    // Measured irradiance and temperatures (all test types)
    const sensorsChart = (p: "POA" | "GHI") => {
        const names = s3.cols.filter((c) => c.group === "data" && c.kind === "value" && c.id.startsWith(`${p} `)).map((c) => c.id);
        const fin = plan.final[p];
        if (!names.length || !x3) return;
        const series = ok([...names.map((n, k) => ser(n.replace(/ \(.*\)$/, ""), s3, n, x3, C.sensors[k % C.sensors.length], { width: 1 })),
            ...(fin && names.length > 1 ? [ser(es ? `${p} filtrado` : `${p} filtered`, s3, fin, x3, "262626", { dash: true, width: 1.5 })] : [])]);
        if (series.length) out.push({ ...next(), kind: "line", title: es ? `Irradiancia ${p}: sensores y valor filtrado` : `${p} irradiance: sensors and filtered value`, series, yTitle: "W/m²", yFmt: "#,##0" });
    };

    if (cfg.type === "EPI") {
        const e = a.epi;
        if (e && e.comp.has("VMeas")) {
            const c6 = e.comp, c7 = e.daily;
            const x6 = r(c6, "Date"), cat = r(c7, "Day");
            if (cat) {
                const bars = ok([ser(es ? "Esperada (PVsyst)" : "Expected (PVsyst)", c7, "Exp", undefined, C.expBar), ser(es ? "Garantizada" : "Guaranteed", c7, "Guar", undefined, C.guar), ser(es ? "Medida" : "Measured", c7, "Meas", undefined, C.meas)].map((s) => s && { ...s, x: undefined }));
                out.push({ sheet: summary, from: { col: 5, row: 0 }, to: { col: 15, row: 20 }, kind: "bar", cat, title: es ? "Energía diaria contada en la prueba" : "Daily energy counted in the test", series: bars, yTitle: "kWh" });
                const dev = r(c7, "Dev");
                if (dev) out.push({ sheet: summary, from: { col: 5, row: 21 }, to: { col: 15, row: 38 }, kind: "bar", cat, title: es ? "Desviación diaria: medida vs garantizada" : "Daily deviation: measured vs guaranteed", series: [{ name: es ? "Desviación" : "Deviation", y: dev, color: "0F6CBD" }], yFmt: "0.0%" });
            }
            if (x6) {
                out.push({ ...next(), kind: "line", title: es ? "Potencia en los pasos contados: esperada, garantizada y medida" : "Power on the counted steps: expected, guaranteed and measured", yTitle: "kW",
                    series: ok([ser(es ? "Esperada (PVsyst)" : "Expected (PVsyst)", c6, "ChExp", x6, C.exp, { dash: true }), ser(es ? "Garantizada" : "Guaranteed", c6, "ChGuar", x6, C.guar, { width: 1.75 }), ser(es ? "Medida" : "Measured", c6, "ChMeas", x6, C.meas)]) });
                out.push({ ...next(), kind: "line", title: es ? "Potencia en todos los pasos" : "Power on all steps", yTitle: "kW",
                    series: ok([ser(es ? "Esperada (PVsyst)" : "Expected (PVsyst)", c6, "Exp", x6, C.exp, { dash: true }), ser(es ? "Garantizada" : "Guaranteed", c6, "Guar", x6, C.guar, { width: 1.75 }), ser(es ? "Medida" : "Measured", c6, "Meas", x6, C.meas)]) });
                if (c6.has("MPOA") && c6.has("ExpPOA")) out.push({ ...next(), kind: "line", title: es ? "Irradiancia: POA medida vs GlobEff PVsyst" : "Irradiance: measured POA vs PVsyst GlobEff", yTitle: "W/m²",
                    series: ok([ser(es ? "POA medida" : "Measured POA", c6, "MPOA", x6, "0F6CBD"), ser("PVsyst GlobEff", c6, "ExpPOA", x6, C.exp, { dash: true })]) });
                const vx = r(c6, "ChExp");
                if (vx) out.push({ ...next(), kind: "scatter", title: es ? "Potencia medida vs esperada (pasos contados)" : "Measured vs expected power (counted steps)", xTitle: es ? "Esperada PVsyst (kW)" : "Expected PVsyst (kW)", yTitle: es ? "Medida (kW)" : "Measured (kW)",
                    series: ok([ser(es ? "Pasos contados" : "Counted steps", c6, "ChMeas", vx, C.meas, { markers: true })]) });
            }
            // Temperatures: measured vs PVsyst
            const s5 = e.pvsyst, x5 = r(s5, "Shifted");
            const tm = plan.final.T_MOD, ta = plan.final.T_AMB;
            const tSeries = ok([
                tm ? ser(es ? "T_MOD medida" : "Measured T_MOD", s3, tm, x3, "0F6CBD") : null,
                s5.has("TArray") ? ser("PVsyst TArray", s5, "TArray", x5, C.exp, { dash: true }) : null,
                ta ? ser(es ? "T_AMB medida" : "Measured T_AMB", s3, ta, x3, "2A9D8F", { width: 1 }) : null,
                s5.has("T_Amb") ? ser("PVsyst T_Amb", s5, "T_Amb", x5, "8A4FBF", { dash: true, width: 1 }) : null,
            ]);
            if (tSeries.length > 1) out.push({ ...next(), kind: "line", title: es ? "Temperaturas: medidas vs PVsyst" : "Temperatures: measured vs PVsyst", yTitle: "ºC", yFmt: "0", series: tSeries });
        }
        sensorsChart("POA");
        sensorsChart("GHI");
    } else if (a.pr) {
        const d = a.pr.daily, cat = r(d, "Day");
        if (cat) out.push({ sheet: summary, from: { col: 5, row: 0 }, to: { col: 15, row: 20 }, kind: "bar", cat, title: es ? "PR diario vs PR de diseño × FT" : "Daily PR vs design PR × FT", yFmt: "0%",
            series: ok([ser(es ? "PR medido (día)" : "Measured PR (day)", d, "PRp", undefined, C.meas)]).map((s) => ({ ...s, x: undefined })),
            overlay: ok([ser(es ? "PR diseño × FT" : "Design PR × FT", d, "PRd", undefined, C.exp, { dash: true, width: 2 })]).map((s) => ({ ...s, x: undefined })) });
        if (plan.eNet && s3.has("PR'_i (kW)") && x3) {
            out.push({ ...next(), kind: "line", title: es ? "Potencia medida vs potencia de referencia PR′" : "Measured power vs reference power PR′", yTitle: "kW",
                series: ok([ser("PR′ (P_stc × Ck × POA / G_stc)", s3, "PR'_i (kW)", x3, C.exp, { dash: true }), ser(es ? "Medida" : "Measured", s3, plan.eNet, x3, C.meas)]) });
            const rx = r(s3, "PR'_i (kW)");
            if (rx) out.push({ ...next(), kind: "scatter", title: es ? "Potencia medida vs PR′" : "Measured power vs PR′", xTitle: "PR′ (kW)", yTitle: es ? "Medida (kW)" : "Measured (kW)", series: ok([ser(es ? "Intervalos" : "Intervals", s3, plan.eNet, rx, C.meas, { markers: true })]) });
        }
        sensorsChart("POA");
        const tm = plan.final.T_MOD;
        if (tm && x3) out.push({ ...next(), kind: "line", title: es ? "Temperatura de módulo" : "Module temperature", yTitle: "ºC", yFmt: "0", series: ok([ser("T_MOD", s3, tm, x3, "0F6CBD")]) });
    }
    return out.filter((s) => s.series.length > 0);
}
