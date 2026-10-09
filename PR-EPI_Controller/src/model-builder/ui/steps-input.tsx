//-----------------------------------------------------------------------
// Wizard steps 1–4: project, data import, sensor mapping, filtering.
//-----------------------------------------------------------------------

import { useState } from "react";
import { Section } from "@/components/ui";
import { PARAMS, mappedSensors, sensorsOf, suggestMapping, workbookNameFor } from "../params";
import { readTableFile, stackTables, minToIso, minToIsoTime, rowTimes, type DateOrder } from "../parse";
import { PROCEDURES, applyProcedure, defaultConfig } from "../presets";
import type { FilterMethod, MeterMode, MeterUnit, ModelConfig, ParamFilter, ParamId, RawTable, TestType } from "../types";
import type { StepProps } from "./state";
import { Btn, Choice, Explain, FileDrop, Grid, Hint, Info, Label, NumField, Pill, SelectField, Stat, Table, TextField, Toggle, Formula } from "./kit";

// ── 1. Project ────────────────────────────────────────────────────────
export function ProjectStep({ d, setD, edit }: StepProps) {
    const p = d.cfg.project;
    const setType = (t: TestType) => {
        if (t === d.cfg.type) return;
        setD((x) => {
            const c = defaultConfig(t);
            c.project = { ...x.cfg.project, lang: x.cfg.project.lang };
            c.mapping = x.cfg.mapping;
            c.periodStart = x.cfg.periodStart;
            c.periodEnd = x.cfg.periodEnd;
            c.albedo = x.cfg.albedo;
            return { ...x, cfg: c, pvsyst: null, meterRaw: null };
        });
    };
    return (
        <>
            <Section title="Test type" sub="Choose the standard the contract follows">
                <div className="grid gap-3 mb-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                    <Choice on={d.cfg.type === "PR"} onClick={() => setType("PR")} title="Performance Ratio · IEC 61724-1" text="Temperature-corrected PR against a monthly design PR." />
                    <Choice on={d.cfg.type === "EPI"} onClick={() => setType("EPI")} title="Energy Performance Index · IEC 61724-3" text="Measured energy against PVsyst re-simulated with site meteo × guaranteed EPI." />
                    <Choice on={false} disabled onClick={() => {}} title="Capacity test · IEC 61724-2" text={<>Regression to reporting conditions. <Pill tone="mute">Phase 2</Pill></>} />
                </div>
            </Section>
            <ProcedureList d={d} setD={setD} />
            <Section title="Project">
                <Grid min={210}>
                    <TextField label="Project name" value={p.name} onChange={(v) => edit((c) => { c.project.name = v; })} placeholder="e.g. Fraga" />
                    <TextField label="SharePoint code" value={p.code} onChange={(v) => edit((c) => { c.project.code = v; })} placeholder="e.g. FRA"
                        info={<>Short project code used in every file the app produces.<span className="ex">Example: FRA → FRA-RawData_20260501-20260510.csv and FRA_Model_….xlsx</span></>} />
                    <SelectField label="Country" value={COUNTRIES.includes(p.country) ? p.country : ""} onChange={(v) => edit((c) => { c.project.country = v; })}
                        options={[{ value: "", label: "— choose —" }, ...COUNTRIES.map((x) => ({ value: x, label: x }))]} />
                    <SelectField label="Workbook language" value={p.lang} options={[{ value: "EN", label: "English" }, { value: "ES", label: "Español" }]} onChange={(v) => edit((c) => { c.project.lang = v; })}
                        info="Language of the sheet names, labels and verdict text in the Excel workbooks. The app itself stays in English." />
                    <TextField label="Client" value={p.client} onChange={(v) => edit((c) => { c.project.client = v; })} />
                    <TextField label="Contract reference" value={p.contractRef} onChange={(v) => edit((c) => { c.project.contractRef = v; })}
                        info="Reference of the contract or the test procedure, printed on the summary sheet." />
                </Grid>
            </Section>
        </>
    );
}

const COUNTRIES = ["Spain", "Poland", "Portugal", "Italy", "Colombia", "El Salvador", "Guatemala"];

/** Contract procedures of the selected test type, one collapsible row each. */
function ProcedureList({ d, setD }: Pick<StepProps, "d" | "setD">) {
    const list = PROCEDURES.filter((pr) => pr.type === d.cfg.type);
    const [open, setOpen] = useState<string | null>(null);
    const cur = d.cfg.procedure;
    const apply = (key: string | null) => setD((x) => key ? { ...x, cfg: { ...applyProcedure(x.cfg, key as never), procedure: key } } : { ...x, cfg: { ...x.cfg, procedure: undefined } });
    return (
        <Section title="Contract procedure" sub={`Optional · ${list.length} for ${d.cfg.type}`}>
            <Hint>Loads the criteria, filters and test period of the procedure. Project values (POI limit, P stc, monthly table, setpoint) are kept, and everything can be changed afterwards.</Hint>
            {list.length === 0 ? <Hint>No procedures saved for this test type yet.</Hint> : (
                <div className="border border-border rounded-sm overflow-hidden">
                    <div className="hidden md:grid grid-cols-[28px_minmax(120px,1fr)_minmax(110px,1fr)_minmax(150px,1.3fr)_minmax(170px,1.5fr)_110px] gap-3 px-3 py-1.5 bg-secondary border-b border-border font-mono text-100 uppercase tracking-[0.08em] text-muted-foreground">
                        <span /><span>Procedure</span><span>Guarantee</span><span>Valid day</span><span>Test period</span><span />
                    </div>
                    {list.map((pr) => {
                        const isOpen = open === pr.key, on = cur === pr.key, f = pr.facts;
                        return (
                            <div key={pr.key} className={`border-b border-border last:border-b-0 ${on ? "bg-[color-mix(in_srgb,var(--color-primary)_7%,var(--color-card))]" : "bg-card"}`}>
                                <div className="grid grid-cols-[28px_minmax(0,1fr)_auto] md:grid-cols-[28px_minmax(120px,1fr)_minmax(110px,1fr)_minmax(150px,1.3fr)_minmax(170px,1.5fr)_110px] gap-3 px-3 py-2.5 items-center text-200">
                                    <button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} details of ${pr.title}`} onClick={() => setOpen(isOpen ? null : pr.key)}
                                        className="w-6 h-6 grid place-items-center rounded-sm text-muted-foreground hover:bg-accent">
                                        <span className={`transition-transform ${isOpen ? "rotate-90" : ""}`}>▸</span>
                                    </button>
                                    <b className="text-300 cursor-pointer" onClick={() => setOpen(isOpen ? null : pr.key)}>{pr.title}</b>
                                    <span className="hidden md:block tabular-nums">{f.guarantee}</span>
                                    <span className="hidden md:block">{f.validDay}</span>
                                    <span className="hidden md:block">{f.period}</span>
                                    <span className="justify-self-end">
                                        {on ? <Pill tone="ok">Applied</Pill> : <Btn onClick={() => apply(pr.key)}>Apply</Btn>}
                                    </span>
                                </div>
                                {isOpen && (
                                    <div className="grid gap-x-8 gap-y-2 px-3 pb-3.5 pl-[52px] text-200 md:grid-cols-[150px_minmax(0,1fr)]">
                                        {([["Guarantee", f.guarantee], ["Valid day", f.validDay], ["Test period", f.period], ["Time resolution", f.resolution], ["Sensor filtering", f.filtering], ["Valid intervals", f.intervals], ["Other", f.other]] as const).map(([k, v]) => (
                                            <div key={k} className="contents">
                                                <span className="font-mono text-100 uppercase tracking-[0.08em] text-muted-foreground pt-0.5">{k}</span>
                                                <span>{v}</span>
                                            </div>
                                        ))}
                                        {on && <div className="md:col-start-2"><button type="button" className="text-100 text-muted-foreground underline" onClick={() => apply(null)}>Stop using this procedure (keeps the current settings)</button></div>}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </Section>
    );
}

// ── Meter block (PR, or EPI with meter in the SCADA file) ───────────────
export function MeterModeBlock({ cfg, edit, scadaMode }: { cfg: ModelConfig; edit: StepProps["edit"]; scadaMode: boolean }) {
    const m = cfg.meter;
    const setMode = (mode: MeterMode) => edit((c) => { c.meter.mode = mode; });
    const formula = m.mode === "two" ? "Net (kW) = Production − ABS(Consumption)" : m.mode === "net" ? "Net (kW) = the meter column as is (+ export, − import)" : "Net (kW) = Production (consumption ignored)";
    return (
        <>
            <div className="grid gap-2.5 mb-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}>
                <Choice on={m.mode === "two"} onClick={() => setMode("two")} title="Production and consumption" text="Two columns, export and import. The import column may come positive or negative." />
                <Choice on={m.mode === "net"} onClick={() => setMode("net")} title="Single net column" text="One bidirectional column, already net: positive when exporting, negative when importing." />
                <Choice on={m.mode === "prod"} onClick={() => setMode("prod")} title="Production only" text="No consumption column. Night import is not subtracted." />
            </div>
            <Grid>
                <SelectField<MeterUnit> label="Values are" value={m.unit} onChange={(v) => edit((c) => { c.meter.unit = v; })}
                    options={[{ value: "power", label: "Average power (kW)" }, { value: "energy", label: "Energy per interval (kWh)" }, { value: "counter", label: "Cumulative counter (kWh)" }]}
                    unit="Counters are converted to energy per interval" />
            </Grid>
            {scadaMode && <Hint className="mt-3">Map the meter column as <b>E_GRID</b>{m.mode === "two" ? <> and the consumption as <b>E_IMP</b></> : null} in the sensor mapping step.</Hint>}
            <Formula>{formula}</Formula>
        </>
    );
}

// ── 2. Data ───────────────────────────────────────────────────────────
export function DataStep({ d, setD, edit, art, notify }: StepProps) {
    const [busy, setBusy] = useState(false);
    const s = art?.stats;
    async function onFiles(files: File[]) {
        setBusy(true);
        try {
            const tables = [];
            for (const f of files) tables.push(await readTableFile(f));
            const raw = stackTables(tables);
            const span = dataSpan(raw, raw.dateCol);
            setD((x) => ({ ...x, scada: raw, restored: null, restoredFrom: "", cfg: { ...x.cfg, periodStart: span?.from ?? "", periodEnd: span?.to ?? "", mapping: suggestMapping(raw.headers, x.cfg.mapping, raw.dateCol) } }));
            notify(span ? `Read ${raw.rows.length} rows from ${files.length} file(s): ${span.from} → ${span.to}. Check how the dates were read below.` : `Read ${raw.rows.length} rows, but no date column was recognised. Choose it below.`);
        } catch (e) {
            notify((e as Error).message);
        } finally {
            setBusy(false);
        }
    }
    const fileNames = d.scada?.fileNames ?? (d.restoredFrom ? [`${d.restoredFrom} (restored)`] : []);
    return (
        <>
            <Section title="Where the data comes from">
                <div className="grid gap-2.5 mb-3.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                    <Choice on onClick={() => {}} title="Upload files" text="Exports from your PC (.xlsx, .xlsm, .csv). Read in the browser; several files are stacked like the Power Query folder import." />
                    <Choice on={false} disabled onClick={() => {}} title="SharePoint folder" text={<>Pick the project folder. <Pill tone="mute">Next phase</Pill></>} />
                    <Choice on={false} disabled onClick={() => {}} title="Lakehouse" text={<>Use the SCADA data the daily pipeline already ingested. <Pill tone="mute">Next phase</Pill></>} />
                </div>
                <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
                    <FileDrop label="SCADA export" accept=".xlsx,.xlsm,.csv" multiple files={fileNames} busy={busy} onFiles={onFiles}
                        meta={d.scada ? `${d.scada.rows.length} rows · ${d.scada.headers.length} columns` : undefined} />
                </div>
                {d.cfg.type === "EPI" && <Hint className="mt-3">The meter and the PVsyst results are not needed yet. You add them in stage 2, after the PVsyst simulation.</Hint>}
            </Section>

            <ReadCheck d={d} setD={setD} edit={edit} />

            {s && (
                <Section title="Test window">
                    <div className="grid gap-2.5 mb-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
                        <Stat label="First timestamp" value={s.first !== null ? minToIsoTime(s.first) : "—"} />
                        <Stat label="Last timestamp" value={s.last !== null ? minToIsoTime(s.last) : "—"} />
                        <Stat label="Interval" value={`${s.stepMin} min`} />
                        <Stat label="Rows" value={s.rows} />
                    </div>
                    <Grid>
                        <label className="block">
                            <Label>Test period from</Label>
                            <input type="date" className="w-full px-2.5 py-1.5 border border-border rounded-sm bg-card text-300" value={d.cfg.periodStart} onChange={(e) => edit((c) => { c.periodStart = e.target.value; })} />
                        </label>
                        <label className="block">
                            <Label info="The last day is included in the test.">Test period to</Label>
                            <input type="date" className="w-full px-2.5 py-1.5 border border-border rounded-sm bg-card text-300" value={d.cfg.periodEnd} onChange={(e) => edit((c) => { c.periodEnd = e.target.value; })} />
                        </label>
                    </Grid>
                    <Hint className="mt-2">Filled in from the first and last day in the files; change it to test a shorter period. Timestamps are taken as end of interval: 00:00 closes the previous day.</Hint>
                </Section>
            )}

            {d.cfg.type === "PR" && (
                <Section title="Meter production" sub="How this project reports energy">
                    <MeterModeBlock cfg={d.cfg} edit={edit} scadaMode />
                </Section>
            )}
        </>
    );
}

/** First and last day covered (end-of-interval stamps: 00:00 belongs to the day before). */
function dataSpan(raw: RawTable, col: number): { from: string; to: string } | null {
    let lo = Infinity, hi = -Infinity;
    for (const x of rowTimes(raw, col)) if (x !== null) { if (x < lo) lo = x; if (x > hi) hi = x; }
    return Number.isFinite(lo) ? { from: minToIso(lo - 1), to: minToIso(hi - 1) } : null;
}

/** How the date column was read, with the option to correct it before anything else. */
function ReadCheck({ d, setD, edit }: Pick<StepProps, "d" | "setD" | "edit">) {
    const raw = d.scada;
    if (!raw) return null;
    const dm = d.cfg.mapping.find((m) => m.param === "DATE");
    const col = dm ? raw.headers.indexOf(dm.raw) : raw.dateCol;
    const times = rowTimes(raw, col);
    const okN = times.filter((x) => x !== null).length;
    const bad = raw.rows.length - okN;
    const samples = [0, 1, raw.rows.length - 1].filter((i, k, a) => i >= 0 && a.indexOf(i) === k);
    const setCol = (j: number) => {
        const span = dataSpan(raw, j);
        edit((c) => {
            c.mapping = c.mapping.map((m) => ({ ...m, param: m.raw === raw.headers[j] ? "DATE" : m.param === "DATE" ? null : m.param }));
            if (span) { c.periodStart = span.from; c.periodEnd = span.to; }
        });
    };
    const setOrder = (o: DateOrder) => setD((x) => {
        const sc = { ...x.scada!, dateOrder: o };
        const span = dataSpan(sc, col);
        return { ...x, scada: sc, cfg: span ? { ...x.cfg, periodStart: span.from, periodEnd: span.to } : x.cfg };
    });
    const show = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "number" && v > 1e6 ? `${minToIsoTime(v)} (Excel date)` : String(v));
    return (
        <Section title="How the files were read" sub={okN ? `${okN.toLocaleString("en-GB")} timestamps` : "no dates found"}>
            <Grid min={220}>
                <SelectField label="Date column" value={String(col)} onChange={(v) => setCol(Number(v))}
                    options={[...(col < 0 ? [{ value: "-1", label: "— choose —" }] : []), ...raw.headers.map((h, j) => ({ value: String(j), label: h }))]}
                    info={<>Chosen by content: the column whose values read as dates. Index columns (1, 2, 3…) are never taken as the date.</>} />
                <SelectField<DateOrder> label="Text date format" value={raw.dateOrder ?? "DMY"} onChange={setOrder}
                    options={[{ value: "DMY", label: "Day-month-year" }, { value: "MDY", label: "Month-day-year" }, { value: "YMD", label: "Year-month-day" }]}
                    info={<>Detected from the values: a first number above 12 can only be the day.<span className="ex">Example: 26-07-2026 08:15 is day-month-year, because there is no month 26. Dates stored by Excel as real dates don't depend on this.</span></>} />
            </Grid>
            <div className="mt-3">
                <Table head={["Row", "Value in the file", "Read as"]}>
                    {samples.map((i) => (
                        <tr key={i}>
                            <td className="tabular-nums text-muted-foreground">{i + 1}</td>
                            <td className="font-mono text-[11.5px]">{col >= 0 ? show(raw.rows[i][col]) : "—"}</td>
                            <td className={`font-mono text-[11.5px] ${times[i] === null ? "text-destructive" : ""}`}>{times[i] === null ? "not a date" : minToIsoTime(times[i]!)}</td>
                        </tr>
                    ))}
                </Table>
            </div>
            {(okN === 0 || bad / raw.rows.length > 0.01) && (
                <div className="border border-destructive text-destructive rounded-sm px-3 py-2 mt-3 text-200">
                    {okN === 0 ? "No date was recognised in this column. Choose the column that holds the date and time." : `${bad.toLocaleString("en-GB")} rows (${((bad / raw.rows.length) * 100).toFixed(1)} %) have no valid date and will be dropped. Check the date column and format.`}
                </div>
            )}
        </Section>
    );
}

// ── 3. Sensors ──────────────────────────────────────────────────────────
const PARAM_OPTIONS = [{ value: "", label: "— ignore —" }, { value: "DATE", label: "Date" }, ...PARAMS.map((p) => ({ value: p.id, label: `${p.id} (${p.unit})` }))];

export function SensorsStep({ d, edit, art }: StepProps) {
    const map = d.cfg.mapping;
    const restored = !d.scada && !!d.restored;
    const counts = PARAMS.map((p) => [p.id, map.filter((m) => m.param === p.id).length] as const).filter(([, n]) => n > 0);
    const sample = (raw: string) => {
        if (!d.scada) return "";
        const j = d.scada.headers.indexOf(raw);
        if (map.find((m) => m.raw === raw)?.param === "DATE") { const t0 = rowTimes(d.scada, j).find((x) => x !== null); return t0 != null ? minToIsoTime(t0) : "not a date"; }
        const nums = d.scada.rows.map((r) => r[j]).filter((v): v is number => typeof v === "number");
        if (!nums.length) return "";
        const max = Math.max(...nums.slice(0, 5000));
        return `max ${Math.round(max * 100) / 100}`;
    };
    if (!map.length) return <Section title="Sensor mapping"><Hint>Load the SCADA export first.</Hint></Section>;
    return (
        <>
        <Section title="Sensor mapping" sub={`${map.length} columns found`}>
            <Hint>Suggestions come from the column names and from the mapping you had before. Fix anything wrong; sensors are numbered in order (POA 01, POA 02…). Ignored columns are not imported.</Hint>
            {restored && <Explain>This model was reopened from a saved workbook, so the mapping is fixed. Load the SCADA files again in the data step to change it.</Explain>}
            <div className="flex flex-wrap gap-1.5 mb-3">
                {counts.map(([p, n]) => <span key={p} className="font-mono text-200 px-2 py-0.5 rounded-sm bg-muted border border-border">{p} <b>×{n}</b></span>)}
            </div>
            <Table head={["SCADA column", "Parameter", "Workbook column", "Sample"]}>
                {map.map((m, i) => (
                    <tr key={m.raw + i} className={m.param ? "" : "text-muted-foreground"}>
                        <td className="font-mono text-[11.5px] max-w-[420px] break-words">{m.raw}</td>
                        <td>
                            <select aria-label={`Parameter for ${m.raw}`} disabled={restored} className="px-1.5 py-1 border border-border rounded-sm bg-card text-200" value={m.param ?? ""}
                                onChange={(e) => edit((c) => { c.mapping[i].param = (e.target.value || null) as ParamId | "DATE" | null; })}>
                                {PARAM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                        </td>
                        <td className="font-mono text-[11.5px] text-[#1d6f42] dark:text-[#5bbf84] whitespace-nowrap">{workbookNameFor(map, i)}</td>
                        <td className="text-100 text-muted-foreground whitespace-nowrap">{sample(m.raw)}</td>
                    </tr>
                ))}
            </Table>
        </Section>
        {art?.stats && <ImportSteps d={d} s={art.stats} />}
        </>
    );
}

function ImportSteps({ d, s }: { d: StepProps["d"]; s: NonNullable<StepProps["art"]>["stats"] }) {
    return (
                <Section title="Import steps" sub="What Power Query did, now done by the app">
                    <ul className="list-none m-0 p-0 mb-1.5">
                        {[
                            [`Stack files`, `${s.files} file(s), ${s.rowsRead} rows read`],
                            [`Keep and rename columns · from the sensor mapping`, `${s.mapped} of ${s.columns}`],
                            [`Rows without a valid date`, `${s.noDate} removed`],
                            [`Remove duplicate timestamps`, `${s.duplicates} removed`],
                            [`Outside the test period`, `${s.outsidePeriod} removed`],
                            [`Irradiance below the minimum → 0 · flagged "Replaced value" (also true zeros at night)`, `${s.replacedRows} rows`],
                            [`Outside the QC limits · flagged "Exceedance of limit values"`, `${s.exceedRows} rows`],
                            [`Missing data · flagged per column`, `${s.missingRows} rows`],
                            ...(d.cfg.qc.interpMaxGap > 0 ? [[`Gaps ≤ ${d.cfg.qc.interpMaxGap} intervals filled by linear interpolation · flagged "Interpolated"`, `${s.interpolatedRows} rows`]] : []),
                            ...(d.cfg.qc.deadAbrupt ? [[`Dead / abrupt-change sensors`, `${s.deadRows} / ${s.abruptRows} rows`]] : []),
                            [`Sort by date and check the interval`, `${s.stepMin} min`],
                        ].map(([a, b]) => (
                            <li key={a} className="grid grid-cols-[18px_minmax(0,1fr)_auto] gap-2 text-200 py-1.5 border-b border-border">
                                <span className="text-[#107c10] font-bold">✓</span><span>{a}</span><span className="text-muted-foreground tabular-nums whitespace-nowrap">{b}</span>
                            </li>
                        ))}
                    </ul>
                    <Hint>Recalculated live with the mapping above. Flags go into the Problematic_Flag column of the internal workbook; they are informative and do not invalidate intervals by themselves. QC limits are set in the filtering step.</Hint>
                </Section>
    );
}

// ── 4. Filtering ────────────────────────────────────────────────────────
export function FilterStep({ d, edit, art }: StepProps) {
    const cfg = d.cfg;
    const plan = art?.plan;
    const params = PARAMS.filter((p) => p.filterable && sensorsOf(cfg.mapping, p.id).length > 0);
    const sensors = mappedSensors(cfg.mapping);
    const refs = sensors.filter((s) => s.param === "REF");
    const globs = sensors.filter((s) => s.param === "GHI" || s.param === "POA");
    const fc = (p: ParamId): ParamFilter => cfg.filters[p] ?? { method: "NONE", dailyTol: 0.05, dailyTwoSided: true, rounds: [] };
    const setF = (p: ParamId, fn: (f: ParamFilter) => void) => edit((c) => { const f = structuredClone(c.filters[p] ?? fc(p)); fn(f); c.filters[p] = f; });
    const discarded = (p: ParamId) => {
        if (!plan) return null;
        let o = 0, dd = 0;
        for (const col of plan.sheet.cols) {
            if (!col.id.startsWith(`${p} `) || col.group !== "filter") continue;
            for (const v of col.values) { if (v === "Outlier") o++; else if (v === "Discard") dd++; }
        }
        return { o, dd };
    };
    return (
        <>
            <Section title="Sensor aggregation" sub="Per parameter">
                <Hint>For each parameter with several sensors, choose how bad readings are removed before averaging. Hover the (i) for what each method does, with an example.</Hint>
                {params.length === 0 ? <Hint>Map at least one irradiance or temperature sensor first.</Hint> : (
                    <Table head={["Parameter", "Sensors", <span key="m" className="inline-flex items-center gap-1.5">Method <Info>{IQR_HELP}</Info></span>, <span key="r" className="inline-flex items-center gap-1.5">Rounds (% / abs) <Info>{ROUNDS_HELP}</Info></span>, "Result"]}>
                        {params.map((p) => {
                            const n = sensorsOf(cfg.mapping, p.id).length;
                            const f = fc(p.id);
                            const rm = discarded(p.id);
                            return (
                                <tr key={p.id}>
                                    <td><b>{p.id}</b> <span className="text-100 text-muted-foreground">({p.unit})</span></td>
                                    <td className="tabular-nums">{n}</td>
                                    <td>
                                        {n < 2 ? <span className="text-100 text-muted-foreground">single sensor</span> : (
                                            <div className="flex flex-col gap-1">
                                                <SelectField<FilterMethod> compact label={`${p.id} method`} value={f.method} onChange={(v) => setF(p.id, (x) => { x.method = v; })}
                                                    options={[...(n >= 4 ? [{ value: "IQR" as FilterMethod, label: "IQR" }] : []), { value: "DAILY_MEAN", label: "Daily mean" }, { value: "NONE", label: "None" }]} />
                                                {f.method === "DAILY_MEAN" && (
                                                    <span className="flex items-center gap-1 text-100">
                                                        tol <NumField compact suffix="%" ariaLabel={`${p.id} daily tolerance %`} value={f.dailyTol} scale={100} onChange={(v) => setF(p.id, (x) => { x.dailyTol = v; })} />
                                                        <label className="flex items-center gap-1 ml-1"><input type="checkbox" checked={f.dailyTwoSided} onChange={(e) => setF(p.id, (x) => { x.dailyTwoSided = e.target.checked; })} />both sides</label>
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                    </td>
                                    <td>
                                        {n < 2 ? <span className="text-100 text-muted-foreground">—</span> : (
                                            <div className="flex flex-col gap-1">
                                                {f.rounds.map((r, k) => (
                                                    <span key={k} className="flex items-center gap-1 text-100 whitespace-nowrap">
                                                        R{k + 1}
                                                        <NumField compact suffix="%" ariaLabel={`${p.id} round ${k + 1} %`} value={r.pct} scale={100} onChange={(v) => setF(p.id, (x) => { x.rounds[k].pct = v; })} />
                                                        <NumField compact suffix={p.unit} ariaLabel={`${p.id} round ${k + 1} abs`} value={r.abs} onChange={(v) => setF(p.id, (x) => { x.rounds[k].abs = v; })} />
                                                        <button type="button" aria-label="Remove round" className="text-muted-foreground px-1" onClick={() => setF(p.id, (x) => { x.rounds.splice(k, 1); })}>×</button>
                                                    </span>
                                                ))}
                                                {f.rounds.length < 3 && <button type="button" className="text-100 text-brand-foreground text-left whitespace-nowrap self-start" onClick={() => setF(p.id, (x) => { x.rounds.push({ pct: 0.05, abs: 0 }); })}>+ round</button>}
                                            </div>
                                        )}
                                    </td>
                                    <td>
                                        <span className="block font-mono text-[11.5px] text-[#1d6f42] dark:text-[#5bbf84] whitespace-nowrap">{plan?.final[p.id] ?? ""}</span>
                                        {rm && (rm.o > 0 || rm.dd > 0) && <span className="block text-100 text-muted-foreground whitespace-nowrap">{rm.o > 0 ? `${rm.o} outliers` : ""}{rm.o > 0 && rm.dd > 0 ? " · " : ""}{rm.dd > 0 ? `${rm.dd} discarded` : ""}</span>}
                                    </td>
                                </tr>
                            );
                        })}
                    </Table>
                )}
                <div className="mt-3 max-w-[220px]"><NumField label="IQR multiplier k" value={cfg.iqrK} onChange={(v) => edit((c) => { c.iqrK = v; })}
                    info={<>How far from the group a reading must be to count as an outlier, in multiples of the spread of the middle sensors. 1.5 is the usual statistical value; a larger k removes fewer readings.</>} /></div>
            </Section>

            {(
                <Section title="Albedo" sub="ALB = REF / reference irradiance">
                    {refs.length === 0 ? <Hint>Map a reflected-irradiance sensor (REF) to calculate albedo.</Hint> : (
                        <>
                            <Table head={["Albedo column", "Reflected (REF)", "Reference", ""]}>
                                {cfg.albedo.map((a, k) => (
                                    <tr key={k}>
                                        <td className="font-mono text-[11.5px] text-[#1d6f42]">ALB {String(k + 1).padStart(2, "0")}</td>
                                        <td><SelectField compact label="REF sensor" value={a.ref} options={refs.map((s) => ({ value: s.short, label: s.short }))} onChange={(v) => edit((c) => { c.albedo[k].ref = v; })} /></td>
                                        <td><SelectField compact label="Reference sensor" value={a.glob} options={globs.map((s) => ({ value: s.short, label: s.short }))} onChange={(v) => edit((c) => { c.albedo[k].glob = v; })} /></td>
                                        <td><button type="button" className="text-muted-foreground" aria-label="Remove albedo pair" onClick={() => edit((c) => { c.albedo.splice(k, 1); })}>×</button></td>
                                    </tr>
                                ))}
                            </Table>
                            <div className="mt-2"><Btn onClick={() => edit((c) => { c.albedo.push({ ref: refs[Math.min(c.albedo.length, refs.length - 1)].short, glob: globs[0]?.short ?? "" }); })}>+ Albedo pair</Btn></div>
                        </>
                    )}
                </Section>
            )}

            <Section title="Quality-control limits" sub="Flag values outside physical bounds">
                <Grid min={190}>
                    <NumField label="Irradiance min" suffix="W/m²" value={cfg.qc.irrMin} onChange={(v) => edit((c) => { c.qc.irrMin = v; })}
                        info={<>Readings below this value are set to 0 and flagged “Replaced value”. Removes the night offset of the pyranometers.<span className="ex">Example (5 W/m²): −2.3 W/m² at 03:00 becomes 0.</span></>} />
                    <NumField label="Irradiance max" suffix="W/m²" value={cfg.qc.irrMax} onChange={(v) => edit((c) => { c.qc.irrMax = v; })}
                        info="Readings above this value are flagged “Exceedance of limit values”." />
                    <NumField label="Temperature min" suffix="ºC" value={cfg.qc.tMin} onChange={(v) => edit((c) => { c.qc.tMin = v; })}
                        info="Ambient temperature below this value is flagged “Exceedance of limit values”." />
                    <NumField label="Temperature max" suffix="ºC" value={cfg.qc.tMax} onChange={(v) => edit((c) => { c.qc.tMax = v; })}
                        info="Ambient temperature above this value is flagged “Exceedance of limit values”." />
                    <NumField label="Fill gaps up to" suffix="intervals" value={cfg.qc.interpMaxGap} onChange={(v) => edit((c) => { c.qc.interpMaxGap = Math.max(0, Math.round(v)); })}
                        info={<>Missing values in gaps of up to this many consecutive intervals are filled by linear interpolation and flagged “Interpolated”. Longer gaps stay missing. 0 = off.<span className="ex">Example (4, 15-min data): a 45-minute gap is filled; a 2-hour gap is not.</span></>} />
                </Grid>
                <div className="flex items-start gap-2.5 mt-3.5">
                    <Toggle checked={cfg.qc.deadAbrupt} onChange={(v) => edit((c) => { c.qc.deadAbrupt = v; })} label="Dead and abrupt-change checks" />
                    <span className="text-200 flex items-center gap-1.5">Also flag dead sensors and abrupt changes
                        <Info><b>Dead sensor:</b> the value barely changes (rate below {cfg.qc.deadDeriv}/s) while it reads above {cfg.qc.deadMinValue}. <b>Abrupt change:</b> a jump faster than {cfg.qc.abruptIrr} W/m² per second, or {cfg.qc.abruptT} ºC per second.<span className="ex">Example: a POA sensor stuck at 734 W/m² for 40 minutes at midday is flagged as dead.</span></Info>
                    </span>
                </div>
            </Section>
        </>
    );
}

const IQR_HELP = <>
    <b>IQR</b> removes, at each timestamp, the reading that doesn't agree with the other sensors: a dirty, shaded or misaligned pyranometer, or one that froze. What counts as “far” adapts to the conditions, because it is measured against the spread of the group at that moment. The reading is left out of the average for that timestamp only.
    <span className="ex">Example: four POA sensors read 812, 815, 818 and 760 W/m² at 12:00. 760 is far from the group, so it is removed and the average is 815 W/m² instead of 801. Needs at least 4 sensors.</span>
    <span className="ex"><b>Daily mean</b> drops a sensor for the whole day when its daily average differs from the average of all sensors by more than the tolerance. It catches sensors that are off all day (soiling, calibration drift). Example (5 %): daily averages 512, 515 and 545 W/m² → mean 524 → the third is 4.0 % above → kept; at 560 it would be 6.4 % above → dropped that day.</span>
</>;
const ROUNDS_HELP = <>
    Each round discards a reading that differs from the average of the sensors by more than the <b>%</b> tolerance <b>and</b> by more than the <b>absolute</b> tolerance, then recalculates the average without it. The absolute value is a minimum difference, so that small differences at low irradiance are not discarded just because they are large in %. With 0 only the % applies, as in the original workbooks.
    <span className="ex">Example (5 % / 10 W/m²): average 615 W/m², reading 650 → 5.7 % and 35 W/m² → discarded.<br />Early morning: average 40 W/m², reading 44 → 10 % but only 4 W/m² → kept.</span>
</>;
