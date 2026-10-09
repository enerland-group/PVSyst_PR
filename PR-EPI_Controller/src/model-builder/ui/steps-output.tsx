//-----------------------------------------------------------------------
// Wizard steps: criteria, export for PVsyst, PVsyst & meter, contract,
// generate.
//-----------------------------------------------------------------------

import { useState, type ReactNode } from "react";
import { Section } from "@/components/ui";
import { PARAMS, sensorsOf } from "../params";
import { colLetter, type ColumnSheet } from "../engine";
import { readPvsystFile, readTableFile, stackTables, minToIsoTime } from "../parse";
import { meterFromTable, suggestMeterColumns } from "../presets";
import { albedoCsv, meteoCsv, periodTag, toCp1252 } from "../meteo";
import { buildWorkbook, workbookFileName } from "../workbook";
import type { Criterion, ModelConfig, ParamId } from "../types";
import type { StepProps } from "./state";
import { MeterModeBlock } from "./steps-input";
import { Btn, Choice, Explain, FileDrop, Formula, Grid, Hint, Label, NumField, Pill, SelectField, Stat, Table, Toggle } from "./kit";
import { saveBlob } from "./download";
import { AlignmentCharts, DataReview, ResultCharts } from "./steps-review";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pct = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(d)} %`);
const kwh = (x: number) => `${Math.round(x).toLocaleString("en-GB")} kWh`;

// ── 5. Criteria ─────────────────────────────────────────────────────────
function CritControls({ c, cfg, edit, i }: { c: Criterion; cfg: ModelConfig; edit: StepProps["edit"]; i: number }) {
    const t = cfg.thr;
    const set = (fn: (x: ModelConfig) => void) => edit(fn);
    const mapped = PARAMS.filter((p) => sensorsOf(cfg.mapping, p.id).length > 0).map((p) => p.id);
    const hasAlb = cfg.albedo.length > 0;
    const paramBoxes = (list: (ParamId | "ALB")[]) => (
        <span className="flex flex-wrap gap-2">
            {list.map((p) => (
                <label key={p} className="flex items-center gap-1">
                    <input type="checkbox" checked={(c.params ?? []).includes(p)} onChange={(e) => set((x) => {
                        const cc = x.criteria[i];
                        cc.params = e.target.checked ? [...(cc.params ?? []), p] : (cc.params ?? []).filter((q) => q !== p);
                    })} />{p}
                </label>
            ))}
        </span>
    );
    const N = (label: string, v: number, fn: (x: ModelConfig, v: number) => void, unit: string) => (
        <span className="flex items-center gap-1.5 whitespace-nowrap">{label} <NumField compact ariaLabel={label} suffix={unit || undefined} value={v} onChange={(nv) => set((x) => fn(x, nv))} /></span>
    );
    let body: ReactNode = null;
    switch (c.type) {
        case "available": body = paramBoxes([...mapped.filter((p) => ["GHI", "POA", "DHI", "T_AMB", "T_MOD", "REF"].includes(p)), ...(hasAlb ? ["ALB" as const] : [])]); break;
        case "threshold": {
            const opts = [...mapped.filter((p) => ["GHI", "POA", "DHI", "REF", "T_AMB", "T_MOD"].includes(p)), ...(hasAlb ? ["ALB" as const] : [])];
            body = <>
                <SelectField compact label="Parameter" value={(c.param ?? "POA") as string} options={opts.map((p) => ({ value: p, label: p }))} onChange={(v) => set((x) => { x.criteria[i].param = v as ParamId | "ALB"; })} />
                <SelectField compact label="Operator" value={c.op ?? ">="} options={[{ value: ">=", label: "≥" }, { value: ">", label: ">" }]} onChange={(v) => set((x) => { x.criteria[i].op = v as ">=" | ">"; })} />
                <NumField compact ariaLabel="Threshold value" value={c.value ?? 0} onChange={(v) => set((x) => { x.criteria[i].value = v; })} />
                <span>{c.param === "ALB" ? "" : "W/m²"}</span>
            </>;
            break;
        }
        case "poaFloor": body = N("POA ≥", t.poaFloor, (x, v) => { x.thr.poaFloor = v; }, "W/m²"); break;
        case "seasonalHours": body = <>
            {N("Summer from month", t.summerStart, (x, v) => { x.thr.summerStart = v; }, "")}
            {N("to", t.summerEnd, (x, v) => { x.thr.summerEnd = v; }, "")}
            {N("POA summer ≥", t.poaThrSummer, (x, v) => { x.thr.poaThrSummer = v; }, "W/m²")}
            {N("rest ≥", t.poaThrWinter, (x, v) => { x.thr.poaThrWinter = v; }, "W/m²")}
            {N("min", t.minHoursDay, (x, v) => { x.thr.minHoursDay = v; }, "h/day")}
        </>; break;
        case "aggHours": body = <>
            {N("Hours ≥", t.minHoursTest, (x, v) => { x.thr.minHoursTest = v; }, "h over the test")}
            <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.aboveSeasonal} onChange={(e) => set((x) => { x.criteria[i].aboveSeasonal = e.target.checked; })} />count only hours above the seasonal POA threshold</label>
            {c.aboveSeasonal && <>
                {N("Summer from month", t.summerStart, (x, v) => { x.thr.summerStart = v; }, "")}
                {N("to", t.summerEnd, (x, v) => { x.thr.summerEnd = v; }, "")}
                {N("POA summer ≥", t.poaThrSummer, (x, v) => { x.thr.poaThrSummer = v; }, "W/m²")}
                {N("rest ≥", t.poaThrWinter, (x, v) => { x.thr.poaThrWinter = v; }, "W/m²")}
            </>}
        </>; break;
        case "exporting": body = (
            <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.dayLevel} onChange={(e) => set((x) => { x.criteria[i].dayLevel = e.target.checked; })} />whole day: invalid if any interval with POA ≥ floor has no injection (100 % availability)</label>
        ); break;
        case "curtailment": body = <>
            {N("POI limit", t.poiKw, (x, v) => { x.thr.poiKw = v; }, "kW")}
            <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.windAlarm} onChange={(e) => set((x) => { x.criteria[i].windAlarm = e.target.checked; })} />wind alarm (WA = 1)</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.pf} onChange={(e) => set((x) => { x.criteria[i].pf = e.target.checked; })} />power factor</label>
            {c.pf && <>{N("PF from", t.pfMin, (x, v) => { x.thr.pfMin = v; }, "")}{N("to", t.pfMax, (x, v) => { x.thr.pfMax = v; }, "")}</>}
        </>; break;
        case "noMissing": body = <>
            {paramBoxes(mapped.filter((p) => ["POA", "T_MOD", "GHI", "T_AMB", "E_GRID"].includes(p)))}
            <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.exceptWhenFloorFails} onChange={(e) => set((x) => { x.criteria[i].exceptWhenFloorFails = e.target.checked; })} />valid when the POA floor already fails (night)</label>
        </>; break;
        case "setpointMin": body = N("Setpoint ≥", t.setpointMin, (x, v) => { x.thr.setpointMin = v; }, "kW"); break;
        case "manual": body = <>
            <span className="flex items-center gap-1 grow">Name
                <input aria-label="Criterion name" className="px-1.5 py-1 border border-border rounded-sm bg-card text-200 grow min-w-[180px]" value={c.label} onChange={(e) => set((x) => { x.criteria[i].label = e.target.value; })} />
            </span>
            {cfg.type === "EPI" && <label className="flex items-center gap-1"><input type="checkbox" checked={!!c.replaceWithExpected} onChange={(e) => set((x) => { x.criteria[i].replaceWithExpected = e.target.checked; })} />replace the measured energy by the expected one instead of excluding</label>}
        </>; break;
    }
    return body ? <div className="flex flex-wrap gap-x-3 gap-y-1.5 items-center text-200 mt-1.5">{body}</div> : null;
}

/** Show "[GHI_Average 1]" instead of "AC2" in the formula preview. */
function readable(f: string, sheet: ColumnSheet): string {
    const byLetter = new Map(sheet.cols.map((c, i) => [colLetter(i), c.header]));
    return f.replace(/(?<![A-Za-z_$!])([A-Z]{1,3})2(?![0-9(])/g, (m, l: string) => (byLetter.has(l) ? `[${byLetter.get(l)}]` : m));
}

const TYPE_TITLE: Record<Criterion["type"], string> = {
    available: "Required parameters available", poaFloor: "Minimum POA irradiance", seasonalHours: "Hours above seasonal threshold per day",
    aggHours: "Minimum aggregated hours over the test", curtailment: "No curtailment, stow or PF deviation", noMissing: "No missing data",
    exporting: "Plant exporting / available", setpointMin: "No curtailment (setpoint minimum)", manual: "Manual criterion",
    threshold: "Parameter threshold",
};
const ADDABLE: { type: Criterion["type"]; label: string }[] = [
    { type: "manual", label: "Manual exclusion column" },
    { type: "threshold", label: "Parameter threshold (e.g. GHI > 10 W/m²)" },
    { type: "available", label: "Parameters recorded" },
    { type: "poaFloor", label: "Minimum POA" },
    { type: "seasonalHours", label: "Hours above seasonal threshold per day" },
    { type: "aggHours", label: "Aggregated hours over the test" },
    { type: "curtailment", label: "Curtailment / stow / PF" },
    { type: "noMissing", label: "No missing data" },
    { type: "exporting", label: "Plant exporting / available" },
    { type: "setpointMin", label: "Setpoint minimum" },
];

export function CriteriaStep({ d, edit, art }: StepProps) {
    const cfg = d.cfg;
    const plan = art?.plan;
    const n = plan?.sheet.n ?? 0;
    const comply = plan ? (plan.sheet.get(plan.comply).values as number[]).reduce((a, b) => a + b, 0) : null;
    return (
        <>
        <Section title="Interval validity" sub={`${cfg.criteria.filter((c) => c.on).length} of ${cfg.criteria.length} active${comply !== null ? ` · ${comply} of ${n} intervals valid` : ""}`}>
            <Hint>An interval counts only if every active criterion returns 1. The green line is the exact formula the workbook gets; thresholds point to named cells in 01 Inputs.</Hint>
            {cfg.criteria.map((c, i) => {
                const cols = plan ? plan.sheet.cols.filter((col) => col.group === "crit" && /^C\d\d$/.test(col.id) && col.note === c.label) : [];
                const pass = cols.map((col) => (col.values as number[]).reduce((a, b) => a + (b === 1 ? 1 : 0), 0));
                return (
                    <div key={c.id} className={`grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border border-border rounded-sm p-3 bg-card mb-2.5 ${c.on ? "" : "opacity-60"}`}>
                        <Toggle checked={c.on} onChange={(v) => edit((x) => { x.criteria[i].on = v; })} label={TYPE_TITLE[c.type]} />
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <b className="text-300">{c.type === "manual" ? c.label || "Manual criterion" : TYPE_TITLE[c.type]}</b>
                                {cols.map((col, k) => <Pill key={col.id} tone={pass[k] === n ? "ok" : "info"}>{col.id} · {pass[k]}/{n} pass</Pill>)}
                                {c.id.startsWith("custom") && <button type="button" className="ml-auto text-100 text-muted-foreground" onClick={() => edit((x) => { x.criteria.splice(i, 1); })}>Remove</button>}
                            </div>
                            {c.type !== "manual" && <div className="text-200 text-muted-foreground">{c.label}</div>}
                            {c.type === "manual" && <div className="text-200 text-muted-foreground">Writes a yellow column of 1s that you can set to 0 by hand in the workbook (e.g. external events).</div>}
                            <CritControls c={c} cfg={cfg} edit={edit} i={i} />
                            {cols.map((col) => col.f && <Formula key={col.id}>={readable(col.f(2), plan!.sheet)}</Formula>)}
                        </div>
                    </div>
                );
            })}
            <AddCriterion edit={edit} />
        </Section>
        <DaysSection d={d} edit={edit} art={art} />
        </>
    );
}

function AddCriterion({ edit }: { edit: StepProps["edit"] }) {
    const [t, setT] = useState<Criterion["type"]>("manual");
    return (
        <div className="flex flex-wrap gap-2 items-center">
            <SelectField compact label="Criterion type" value={t} options={ADDABLE.map((a) => ({ value: a.type, label: a.label }))} onChange={setT} />
            <Btn onClick={() => edit((x) => {
                const label = ADDABLE.find((a) => a.type === t)!.label;
                x.criteria.push({ id: `custom${Date.now()}`, type: t, on: true, label, ...(t === "threshold" ? { param: "GHI" as const, op: ">" as const, value: 10 } : {}), ...(t === "available" ? { params: [] } : {}), ...(t === "curtailment" ? { windAlarm: true, pf: false } : {}) });
            })}>+ Add criterion</Btn>
        </div>
    );
}

function DaysSection({ d, edit, art }: Pick<StepProps, "d" | "edit" | "art">) {
    const dc = d.cfg.days;
    const sel = d.cfg.type === "EPI" ? art?.epi?.days : art?.pr?.days;
    const sd = d.cfg.type === "EPI" ? art?.epi?.daily : art?.pr?.daily;
    const setD = (fn: (x: ModelConfig) => void) => edit(fn);
    const iso = (serial: number) => new Date((serial - 25569) * 864e5).toISOString().slice(0, 10);
    return (
        <Section title="Valid days and test period" sub={sel ? `${sel.daysSelected} of ${sel.daysNeeded || "—"} days used${sel.fallbackActive ? " · highest-irradiation fallback active" : ""}` : "Applied in the daily sheet"}>
            <Hint>A day is valid when it has valid intervals and meets the day conditions below. The test uses the first N valid days inside the window; days outside it are not used.</Hint>
            <Grid min={200}>
                <NumField label="Valid days required" suffix="days" value={dc.required} onChange={(v) => setD((x) => { x.days.required = v; })}
                    info="Number of valid days the test needs. 0 = no requirement: every valid day is used." />
                <NumField label="Maximum window" suffix="days" value={dc.maxWindow} onChange={(v) => setD((x) => { x.days.maxWindow = v; })}
                    info={<>Calendar days, counted from the first day of the test, within which the valid days must be found. 0 = no limit.<span className="ex">Example (15): test starting 1 May → only days from 1 to 15 May can be used.</span></>} />
                <NumField label="Fallback: best days" suffix="days" value={dc.fallbackTopK} onChange={(v) => setD((x) => { x.days.fallbackTopK = v; })}
                    info={<>If the window ends without enough valid days, the test uses this many days with the highest irradiation in the window instead. 0 = off: the test is reported as not complete.<span className="ex">Example (6): only 7 valid days in 15 → the 6 days with the most Wh/m² are used.</span></>} />
                <SelectField label="Irradiation over" value={dc.irrAllIntervals ? "all" : "valid"} options={[{ value: "all", label: "All intervals of the day" }, { value: "valid", label: "Valid intervals only" }]} onChange={(v) => setD((x) => { x.days.irrAllIntervals = v === "all"; })}
                    info="Whether the daily irradiation sums all intervals of the day or only the valid ones." />
                <NumField label="Min. hours above POA" suffix="h" value={dc.minHours} onChange={(v) => setD((x) => { x.days.minHours = v; })}
                    info={<>The day needs at least this many hours of valid intervals with POA at or above the threshold on the right. 0 = off.<span className="ex">Example (3 h at 500 W/m², 15-min data): 13 valid intervals ≥ 500 W/m² = 3.25 h → the day passes.</span></>} />
                <NumField label="POA threshold" suffix="W/m²" value={dc.hoursPoaThr} onChange={(v) => setD((x) => { x.days.hoursPoaThr = v; })}
                    info="Irradiance used to count the hours on the left." />
                <NumField label="Min. daily irradiation" suffix="Wh/m²" value={dc.minDailyWh} onChange={(v) => setD((x) => { x.days.minDailyWh = v; })}
                    info={<>The day's POA irradiation must exceed this value. It is integrated as Σ POA ÷ intervals per hour. 0 = off.<span className="ex">Example: 96 intervals of 15 min with Σ POA = 26,400 W/m² → 26,400 ÷ 4 = 6,600 Wh/m².</span></>} />
                {d.cfg.qc.interpMaxGap > 0 && <NumField label="Max. interpolated" suffix="%" scale={100} value={dc.maxInterpPct} onChange={(v) => setD((x) => { x.days.maxInterpPct = v; })}
                    info="Largest share of the day's valid intervals that may come from interpolation." />}
            </Grid>
            {sd && sel && (
                <div className="mt-4">
                    <Table head={["Day", d.cfg.type === "EPI" ? "Valid steps" : "Valid intervals", "Hours ≥ thr.", "Irradiation", ...(d.cfg.type === "PR" ? ["PR (day)"] : sd.has("Dev") ? ["Deviation"] : []), "Valid", "Used"]}>
                        {(sd.get("Day").values as number[]).map((day, i) => {
                            const pr = d.cfg.type === "PR" ? (sd.get("PRp").values[i] as number) : null;
                            const dev = d.cfg.type === "EPI" && sd.has("Dev") ? sd.get("Dev").values[i] : null;
                            const low = pr !== null && pr > 0 && pr < 0.5;
                            return (
                                <tr key={day} className={sel.selected[i] ? "" : "text-muted-foreground"}>
                                    <td className="tabular-nums whitespace-nowrap">{iso(day)}</td>
                                    <td className="tabular-nums">{sd.get("VI").values[i] as number}</td>
                                    <td className="tabular-nums">{(sd.get("Hours").values[i] as number).toFixed(2)} h</td>
                                    <td className="tabular-nums">{Math.round(sd.get("Irr").values[i] as number).toLocaleString("en-GB")} Wh/m²</td>
                                    {d.cfg.type === "PR" && <td className={`tabular-nums ${low ? "text-destructive font-semibold" : ""}`} title={low ? "Very low PR: check availability or curtailment that day" : undefined}>{((pr ?? 0) * 100).toFixed(1)} %{low ? " !" : ""}</td>}
                                    {d.cfg.type === "EPI" && sd.has("Dev") && <td className="tabular-nums">{typeof dev === "number" ? `${(dev * 100).toFixed(2)} %` : "—"}</td>}
                                    <td>{sel.valid[i] ? "✓" : "—"}</td>
                                    <td>{sel.selected[i] ? <Pill tone="ok">used</Pill> : ""}</td>
                                </tr>
                            );
                        })}
                    </Table>
                    {d.cfg.type === "PR" && (sd.get("PRp").values as number[]).some((v, i) => sel.selected[i] && v > 0 && v < 0.5) && (
                        <Explain>Some days used in the test have a PR below 50 %. That usually means part of the plant was unavailable or limited (e.g. output clipped while the setpoint shows no limitation). Check those days and exclude them if the cause is not attributable to the contractor.</Explain>
                    )}
                </div>
            )}
        </Section>
    );
}

// ── EPI stage 1 end: export ──────────────────────────────────────────────
export function ExportStep({ d, art, notify }: StepProps) {
    const [busy, setBusy] = useState(false);
    const meteo = art?.meteo;
    const plan = art?.plan;
    if (!meteo || !plan) return <Section title="Data review"><Hint>Load the SCADA data to review it and prepare the meteo for PVsyst.</Hint></Section>;
    const tag = periodTag(plan);
    const code = d.cfg.project.code || d.cfg.project.name || "Project";
    const alb = albedoCsv(meteo);
    async function saveStage1() {
        setBusy(true);
        try {
            const buf = await buildWorkbook(art!, { client: false });
            saveBlob(buf, workbookFileName(d.cfg, tag, false).replace("_Model_", "_Model_Stage1_"), XLSX_MIME);
            notify("Stage 1 workbook saved. Reopen it with “Open saved model…” when the PVsyst results are ready.");
        } finally { setBusy(false); }
    }
    return (
        <>
        <Section title="Data review" sub="Check the measurements before PVsyst">
            <Hint>Look for gaps, sensors that drift away from the others and days that fail the criteria. Hover a chart to read the values; use the slider under it to zoom.</Hint>
            <DataReview d={d} art={art} />
        </Section>
        <Section title="End of stage 1" sub="Measured meteo for PVsyst">
            <Explain>The filtered measured data is ready. Download it, run the PVsyst simulation with it, and come back to stage 2 with the results. Save the stage 1 workbook: it holds the data and this configuration, so you can reopen it later instead of loading the SCADA files again.</Explain>
            <Table head={["CSV column", "Source in the workbook", "Valid values"]}>
                {meteo.cols.map((c) => (
                    <tr key={c.id}>
                        <td className="font-mono text-[11.5px] text-[#1d6f42]">{c.header}</td>
                        <td className="font-mono text-[11.5px]">{c.id === "Date" ? "Date" : c.note?.replace("= ", "")}</td>
                        <td className="tabular-nums text-200">{c.values.filter((v) => typeof v === "number").length} / {meteo.n}</td>
                    </tr>
                ))}
            </Table>
            <div className="flex flex-wrap gap-2.5 mt-3.5">
                <Btn kind="excel" onClick={() => saveBlob(toCp1252(meteoCsv(meteo)), `${code}-RawData_${tag}.csv`, "text/csv")}>Meteo CSV for PVsyst</Btn>
                {alb && <Btn onClick={() => saveBlob(toCp1252(alb), `${code}-Albedo_${tag}.csv`, "text/csv")}>Albedo CSV</Btn>}
                <Btn kind="primary" disabled={busy} onClick={() => void saveStage1()}>{busy ? "Building…" : "Save stage 1 workbook"}</Btn>
            </div>
            <Hint className="mt-2.5">Same format as the old macro: {code}-RawData_{tag}.csv (comma separated, M/D/YYYY H:MM, Windows-1252).</Hint>
        </Section>
        </>
    );
}

// ── EPI stage 2: PVsyst & meter ──────────────────────────────────────────
export function ResultsStep({ d, setD, edit, art, notify }: StepProps) {
    const [busy, setBusy] = useState<"" | "pv" | "meter">("");
    const cfg = d.cfg;
    const m = cfg.meter;
    async function onPv(files: File[]) {
        setBusy("pv");
        try {
            const pv = await readPvsystFile(files[0]);
            setD((x) => ({ ...x, pvsyst: pv }));
            notify(`PVsyst: ${pv.t.length} rows, step ${pv.stepMin} min, ${minToIsoTime(pv.t[0])} → ${minToIsoTime(pv.t[pv.t.length - 1])}.`);
        } catch (e) { notify((e as Error).message); } finally { setBusy(""); }
    }
    async function onMeter(files: File[]) {
        setBusy("meter");
        try {
            const tables = [];
            for (const f of files) tables.push(await readTableFile(f));
            const raw = stackTables(tables);
            const sug = suggestMeterColumns(raw);
            setD((x) => {
                const c = structuredClone(x.cfg);
                c.meter.dateCol = sug.date;
                c.meter.prodCol = raw.headers.includes(c.meter.prodCol) ? c.meter.prodCol : sug.prod;
                c.meter.consCol = raw.headers.includes(c.meter.consCol) ? c.meter.consCol : sug.cons;
                if (!c.meter.consCol && c.meter.mode === "two") c.meter.mode = "prod";
                return { ...x, meterRaw: raw, cfg: c };
            });
            notify(`Meter: ${raw.rows.length} rows from ${files.length} file(s).`);
        } catch (e) { notify((e as Error).message); } finally { setBusy(""); }
    }
    const meterTable = (() => { try { return d.meterRaw && m.prodCol ? meterFromTable(d.meterRaw, cfg) : null; } catch { return null; } })();
    const consSign = meterTable && m.mode === "two" ? (meterTable.cons.some((v) => v !== null && v < 0) ? "negative" : "positive") : null;
    const headers = d.meterRaw?.headers ?? [];
    const opt = (h: string[]) => [{ value: "", label: "—" }, ...h.map((x) => ({ value: x, label: x }))];
    const epi = art?.epi;
    return (
        <>
            <Section title="PVsyst simulation results" sub="CSV export · any time step">
                <div className="grid gap-3 mb-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
                    <FileDrop label="PVsyst results" accept=".csv" files={d.pvsyst ? [d.pvsyst.fileName] : []} busy={busy === "pv"} onFiles={onPv}
                        meta={d.pvsyst ? `${d.pvsyst.t.length} rows · ${d.pvsyst.stepMin} min step · ${d.pvsyst.headers.join(", ")}` : "Must include E_Grid (and GlobEff for the expected POA). The time step is read from the file."} />
                </div>
                <Grid min={220}>
                    <SelectField label="Comparison resolution" value={cfg.epi.aggregateByHour ? "h" : "n"} onChange={(v) => edit((c) => { c.epi.aggregateByHour = v === "h"; })}
                        options={[{ value: "n", label: `Native (${art?.plan.ds.stepMin ?? 15} min)` }, { value: "h", label: "Hourly" }]}
                        info={<><b>Native:</b> each SCADA interval is compared with its PVsyst step. <b>Hourly:</b> SCADA intervals are grouped into hours, and an hour is valid only when all its intervals are valid.</>} />
                </Grid>
                {d.pvsyst && epi && <Hint className="mt-2.5">{epi.comp.n} comparison steps match the SCADA period.{epi.comp.n === 0 ? " Check the time shift and the period." : ""}</Hint>}
            </Section>

            <Section title="Meter production" sub="How this project reports energy">
                <div className="grid gap-2.5 mb-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                    <Choice on={m.source === "file"} onClick={() => edit((c) => { c.meter.source = "file"; })} title="Separate meter export" text="One or more files from the revenue meter." />
                    <Choice on={m.source === "scada"} onClick={() => edit((c) => { c.meter.source = "scada"; })} title="In the SCADA file" text="The meter columns are mapped as E_GRID / E_IMP in the sensor mapping." />
                </div>
                {m.source === "file" && (
                    <>
                        <div className="grid gap-3 mb-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
                            <FileDrop label="Meter export" accept=".xlsx,.xlsm,.csv" multiple files={d.meterRaw?.fileNames ?? []} busy={busy === "meter"} onFiles={onMeter}
                                meta={meterTable ? `${meterTable.t.length} rows · ${meterTable.stepMin} min` : undefined} />
                        </div>
                        {d.meterRaw && (
                            <div className="mb-3">
                                <Grid min={220}>
                                    <SelectField label="Date column" value={m.dateCol} options={opt(headers)} onChange={(v) => edit((c) => { c.meter.dateCol = v; })} />
                                    <SelectField label={m.mode === "two" ? "Production column" : "Meter column"} value={m.prodCol} options={opt(headers)} onChange={(v) => edit((c) => { c.meter.prodCol = v; })} />
                                    {m.mode === "two" && <SelectField label="Consumption column" value={m.consCol} options={opt(headers)} onChange={(v) => edit((c) => { c.meter.consCol = v; })} unit={consSign ? `Detected: values are ${consSign}` : undefined} />}
                                </Grid>
                            </div>
                        )}
                    </>
                )}
                <MeterModeBlock cfg={cfg} edit={edit} scadaMode={m.source === "scada"} />
                {meterTable && <MeterCheck t={meterTable.t} prod={meterTable.prod} scadaT={art?.plan.ds.t ?? []} />}
            </Section>
            <AlignmentCharts d={d} edit={edit} art={art} />
        </>
    );
}

/** Sanity checks so that a wrong column or date never ends as “0 kWh” without a warning. */
function MeterCheck({ t, prod, scadaT }: { t: number[]; prod: (number | null)[]; scadaT: number[] }) {
    const s = new Set(scadaT);
    const match = t.filter((x) => s.has(x)).length;
    const vals = prod.filter((v): v is number => v !== null);
    const nonZero = vals.filter((v) => v !== 0).length;
    const peak = vals.length ? Math.max(...vals) : 0;
    const warn: string[] = [];
    if (!vals.length || nonZero === 0) warn.push("The production column has no values other than 0. Check that the right column is selected.");
    if (scadaT.length && match === 0) warn.push("No meter timestamp matches the SCADA data. Check the date column of the meter file and the test period.");
    else if (scadaT.length && match < t.length * 0.5) warn.push(`Only ${match} of ${t.length} meter timestamps match the SCADA data.`);
    return (
        <div className="mt-3">
            <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
                <Stat label="Meter rows" value={t.length.toLocaleString("en-GB")} />
                <Stat label="Matching SCADA" value={scadaT.length ? `${match.toLocaleString("en-GB")}` : "—"} />
                <Stat label="Non-zero values" value={nonZero.toLocaleString("en-GB")} />
                <Stat label="Peak" value={`${Math.round(peak).toLocaleString("en-GB")}`} />
            </div>
            {warn.map((w) => <div key={w} className="border border-destructive text-destructive rounded-sm px-3 py-2 mt-2.5 text-200">{w}</div>)}
        </div>
    );
}

// ── Contract ───────────────────────────────────────────────────────────
export function ContractStep({ d, edit, art }: StepProps) {
    const cfg = d.cfg;
    if (cfg.type === "EPI") {
        const e = cfg.epi;
        return (
            <>
                <Section title="Guarantee" sub="IEC 61724-3">
                    <Grid>
                        <NumField label="Guaranteed EPI" value={e.guaranteedEpi} onChange={(v) => edit((c) => { c.epi.guaranteedEpi = v; })} />
                        <NumField label="Degradation factor" value={e.degradation} onChange={(v) => edit((c) => { c.epi.degradation = v; })} />
                        <NumField label="Availability factor" value={e.availability} onChange={(v) => edit((c) => { c.epi.availability = v; })} />
                    </Grid>
                    <Hint className="mt-3">Pass rule: Σ measured ≥ Σ guaranteed over the valid steps. The summary also shows the measured EPI (measured / expected), which is equivalent.</Hint>
                </Section>
                <Section title="Formulas">
                    <Formula>{`Guaranteed (kW)  = Guaranteed_EPI × Degradation × Availability × [Expected production PVsyst]
Valid            = IF(valid SCADA intervals in the step ≥ Intervals_per_bucket, 1, 0)
Energy (kWh)     = Σ valid power × Bucket_h`}</Formula>
                </Section>
            </>
        );
    }
    const pr = cfg.pr;
    const k = art?.pr?.kpi;
    return (
        <>
            <Section title="Plant and module" sub="IEC 61724-1">
                <Grid>
                    <NumField label="P stc" unit={`kWp${pr.pstcNote ? ` · ${pr.pstcNote}` : ""}`} value={pr.pstcKwp} onChange={(v) => edit((c) => { c.pr.pstcKwp = v; })} />
                    <label className="block"><Label>P stc note</Label><input className="w-full px-2.5 py-1.5 border border-border rounded-sm bg-card text-300" value={pr.pstcNote} placeholder="e.g. 8580 modules × 655 Wp" onChange={(e) => edit((c) => { c.pr.pstcNote = e.target.value; })} /></label>
                    <NumField label="G stc" unit="W/m²" value={pr.gstc} onChange={(v) => edit((c) => { c.pr.gstc = v; })} />
                    <NumField label="δ temperature coefficient" unit="%/ºC (Pmax, from the datasheet)" value={pr.deltaPctPerC} onChange={(v) => edit((c) => { c.pr.deltaPctPerC = v; })} />
                    <NumField label="Tolerance factor FT" value={pr.ft} onChange={(v) => edit((c) => { c.pr.ft = v; })} />
                    <SelectField label="Overall PR" value={pr.overall} onChange={(v) => edit((c) => { c.pr.overall = v; })}
                        options={[{ value: "mean", label: "Mean of daily PR" }, { value: "weighted", label: "Energy-weighted ΣE / ΣPR'" }]} />
                </Grid>
                <Explain>
                    <b>Energy-weighted ΣE / ΣPR′</b> sums energy and reference power over all the days used and divides once. It is the IEC 61724-1 definition: PR = ΣE_i / Σ[P_STC·G_i/G_STC·(1+δ(T_cell−T_avg))]. <b>Mean of daily PR</b> gives every day the same weight, whatever its irradiation.
                    {k && <> With the current data: mean {pct(k.prMean)}, energy-weighted {pct(k.prWeighted)}, guaranteed {pct(k.prGuaranteed)}.</>}
                </Explain>
            </Section>
            <Section title="Monthly contractual values" sub="Tavg (ºC) / design PR (%)">
                <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))" }}>
                    {MONTHS.map((mo, i) => (
                        <div key={mo} className="border border-border rounded-sm p-1.5 bg-secondary flex flex-col gap-1">
                            <span className="font-mono text-100 uppercase tracking-[0.1em] text-muted-foreground">{mo}</span>
                            <NumField compact ariaLabel={`Tavg ${mo}`} value={pr.tavg[i]} onChange={(v) => edit((c) => { c.pr.tavg[i] = v; })} />
                            <NumField compact ariaLabel={`Design PR ${mo} %`} value={pr.prDesign[i]} scale={100} onChange={(v) => edit((c) => { c.pr.prDesign[i] = v; })} />
                        </div>
                    ))}
                </div>
                <Formula>{`Ck   = 1 + Delta × (T_MOD − Tavg_Month(month))
PR'ᵢ = P_stc × Ck × POA / G_stc
PRd  = FT × PR_Design_Month(month)`}</Formula>
            </Section>
            <Section title="Albedo check" sub="Recalculate the design PR if the measured albedo deviates">
                <Grid>
                    <NumField label="Albedo of the design model" value={pr.albedoBase} onChange={(v) => edit((c) => { c.pr.albedoBase = v; })}
                        info={<>Albedo used in the design (PVsyst) model. If the measured albedo on the test days deviates more than the allowed %, the design PR has to be recalculated with the measured albedo. 0 = no check.<span className="ex">Example: model 0.17, allowed 20 % → measured albedo between 0.136 and 0.204 is accepted.</span></>} />
                    <NumField label="Allowed deviation" suffix="%" scale={100} value={pr.albedoTol} onChange={(v) => edit((c) => { c.pr.albedoTol = v; })} />
                </Grid>
                {pr.albedoBase > 0 && (k?.albedo !== null && k?.albedo !== undefined
                    ? <Hint className="mt-2.5">Measured albedo on the days used: {k.albedo.toFixed(3)} ({((k.albedo / pr.albedoBase - 1) * 100).toFixed(1)} % vs the model).{Math.abs(k.albedo / pr.albedoBase - 1) > pr.albedoTol ? " Above the tolerance: the design PR has to be recalculated with the measured albedo." : " Within the tolerance."}</Hint>
                    : <Hint className="mt-2.5">Add an albedo pair (REF / reference sensor) in the filtering step to measure the albedo.</Hint>)}
            </Section>
        </>
    );
}

// ── Generate ───────────────────────────────────────────────────────────
export function GenerateStep({ d, art, err, notify, go }: StepProps) {
    const [busy, setBusy] = useState<"" | "int" | "cli">("");
    const cfg = d.cfg;
    if (!art) return <Section title="Review"><Hint>{err ?? "Load the SCADA data first."}</Hint></Section>;
    const plan = art.plan;
    const tag = periodTag(plan);
    const stage2Missing = cfg.type === "EPI" && !art.epi;
    async function gen(client: boolean) {
        setBusy(client ? "cli" : "int");
        try {
            const buf = await buildWorkbook(art!, { client });
            const name = workbookFileName(cfg, tag, client);
            saveBlob(buf, name, XLSX_MIME);
            notify(`${name} downloaded.`);
        } catch (e) { notify((e as Error).message); } finally { setBusy(""); }
    }
    const valid = (plan.sheet.get(plan.comply).values as number[]).reduce((a, b) => a + b, 0);
    const pass = cfg.type === "EPI" ? art.epi?.kpi.pass : art.pr?.kpi.pass;
    const hasVerdict = cfg.type === "PR" ? !!art.pr : !!art.epi && art.epi.comp.has("VMeas");
    const sel = cfg.type === "PR" ? art.pr?.days : art.epi?.days;
    const complete = sel?.complete ?? true;
    return (
        <>
            {hasVerdict && (
                <div className={`border border-border border-l-4 rounded-r-md px-4 py-3 mb-5 ${pass ? "border-l-[#107c10]" : "border-l-destructive"}`}>
                    <div className="font-mono text-100 uppercase tracking-[0.12em] text-muted-foreground mb-1">Result (same numbers the workbook calculates)</div>
                    <div className={`text-400 font-bold ${!complete ? "text-[#9a5b00] dark:text-[#f2c661]" : pass ? "text-[#107c10] dark:text-[#6ccb5f]" : "text-destructive"}`}>
                        {!complete ? `Test not complete: ${sel!.daysSelected} of ${sel!.daysNeeded} valid days — provisional result: ${pass ? "above" : "below"} the guarantee` : pass ? "Test passed" : "Test not passed"}
                    </div>
                    <div className="grid gap-2.5 mt-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
                        {cfg.type === "EPI" && art.epi && <>
                            <Stat label="Guaranteed" value={kwh(art.epi.kpi.guaranteedKwh)} />
                            <Stat label="Measured" value={kwh(art.epi.kpi.measuredKwh)} />
                            <Stat label="Deviation" value={pct(art.epi.kpi.deviation)} />
                            <Stat label="Measured EPI" value={art.epi.kpi.epiMeasured?.toFixed(4) ?? "—"} />
                            <Stat label="Days used" value={`${art.epi.days.daysSelected} / ${art.epi.days.daysNeeded || "—"}`} />
                        </>}
                        {cfg.type === "PR" && art.pr && <>
                            <Stat label={cfg.pr.overall === "weighted" ? "PR measured (ΣE/ΣPR')" : "PR measured (mean of days)"} value={pct(art.pr.kpi.prReal)} />
                            <Stat label="PR design × FT" value={pct(art.pr.kpi.prGuaranteed)} />
                            <Stat label="Difference" value={pct(art.pr.kpi.deviation)} />
                            <Stat label="Days used" value={`${art.pr.days.daysSelected} / ${art.pr.days.daysNeeded || "—"}`} />
                        </>}
                    </div>
                </div>
            )}
            {hasVerdict && <ResultCharts d={d} art={art} />}
            <Section title="Review">
                <ul className="list-none p-0 m-0 mb-4 grid gap-1.5 text-200">
                    <li>✓ {plan.sheet.cols.filter((c) => c.group === "data" && c.kind === "value").length} sensors imported · {plan.sheet.n} intervals · {art.stats.stepMin} min</li>
                    <li>✓ {plan.criteriaCols.length} criteria columns · {valid} valid intervals · {plan.inputs.length} named inputs</li>
                    <li>✓ {plan.sheet.cols.length} columns in the data sheet, {plan.sheet.cols.filter((c) => c.f).length} with formulas</li>
                    {stage2Missing && <li className="text-[#9a5b00]">! PVsyst results or meter missing: the workbook stops at stage 1. <button type="button" className="underline" onClick={() => go("results")}>Add them</button></li>}
                    {cfg.type === "EPI" && art.epi && !art.epi.comp.has("VMeas") && <li className="text-[#9a5b00]">! No meter data: the comparison has no measured production.</li>}
                </ul>
            </Section>
            <Section title="Named inputs written to 01 Inputs">
                <Table head={["Name", "Value", "Unit"]}>
                    {plan.inputs.map((i) => (
                        <tr key={i.name}>
                            <td className="font-mono text-[11.5px] text-[#1d6f42] dark:text-[#5bbf84]">{i.name}</td>
                            <td className="tabular-nums text-200">{Array.isArray(i.value) ? i.value.map((v) => Math.round(v * 1e4) / 1e4).join(" · ") : i.value}</td>
                            <td className="text-200 text-muted-foreground">{i.unit}</td>
                        </tr>
                    ))}
                </Table>
            </Section>
            <Section title="Download">
                <div className="flex flex-wrap gap-2.5">
                    <Btn kind="excel" disabled={!!busy} onClick={() => void gen(false)}>{busy === "int" ? "Building…" : "Internal workbook (.xlsx)"}</Btn>
                    <Btn disabled={!!busy} onClick={() => void gen(true)}>{busy === "cli" ? "Building…" : "Client workbook (.xlsx)"}</Btn>
                </div>
                <Hint className="mt-2.5">Neither workbook contains Power Query or macros. The client workbook also leaves out the internal flag column (Problematic_Flag), the sensor map and the saved configuration, and keeps every formula. The internal workbook can be reopened here with “Open saved model…”.</Hint>
            </Section>
        </>
    );
}
