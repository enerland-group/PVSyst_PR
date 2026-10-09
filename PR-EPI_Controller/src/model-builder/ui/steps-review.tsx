//-----------------------------------------------------------------------
// Wizard steps with charts: exclusions, data review (end of stage 1) and
// the stage-2 comparison charts (PVsyst alignment, results).
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Section } from "@/components/ui";
import { PARAMS, mappedSensors, sensorsOf } from "../params";
import { minToIso, minToIsoTime } from "../parse";
import type { Exclusion, ParamId, PvsystTable } from "../types";
import type { StepProps } from "./state";
import { Btn, Hint, Info, Label, NumField, Pill, SelectField } from "./kit";
import { BarChart, ChartCard, Heatmap, PALETTE, Scatter, TimeChart, type CellState, type Range } from "./charts";

const CAUSES = ["Grid / TSO limitation", "Owner's instruction", "Force majeure", "Third-party works", "Communication loss", "Other"];
const inputCls = "w-full px-2.5 py-1.5 text-300 border border-border rounded-sm bg-card text-foreground outline-none focus:ring-2 focus:ring-ring";

// ── Exclusions ─────────────────────────────────────────────────────────
export function ExclusionsStep({ d, edit, art }: StepProps) {
    const list = d.cfg.days.excluded;
    const set = (k: number, fn: (e: Exclusion) => void) => edit((c) => { fn(c.days.excluded[k]); });
    const first = art?.plan.ds.t[0], last = art?.plan.ds.t[art.plan.ds.t.length - 1];
    const defDay = first !== undefined ? minToIso(first - 1) : "";
    const add = () => edit((c) => { c.days.excluded.push({ from: `${defDay}T00:00`, to: `${defDay}T00:00`, cause: CAUSES[0], reason: "", evidence: "" }); });
    // Intervals removed by each period, to confirm the dates hit the data
    const hits = (e: Exclusion) => {
        if (!art) return null;
        const a = Date.parse(`${e.from}Z`), b = Date.parse(`${e.to}Z`);
        if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
        const am = a / 60000 + 25569 * 1440, bm = b / 60000 + 25569 * 1440;
        return art.plan.ds.t.filter((t) => am < t && t <= bm).length;
    };
    return (
        <Section title="Excluded periods" sub={list.length ? `${list.length} period${list.length > 1 ? "s" : ""}` : "Events not attributable to the contractor"}>
            <Hint>Each period is written to the workbook, client version included, with its cause and reason, so the client sees why it was removed. A whole day (00:00 → 00:00 of the next day) is excluded from the test; part of a day removes only those intervals, and the day can still count if it meets the day rules.</Hint>
            {list.map((e, k) => {
                const n = hits(e);
                const bad = e.from && e.to && e.to <= e.from;
                return (
                    <div key={k} className="border border-border rounded-sm bg-card p-3 mb-2.5">
                        <div className="grid gap-3 items-start" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
                            <label className="block min-w-0"><Label>From</Label><input type="datetime-local" className={inputCls} value={e.from} onChange={(ev) => set(k, (x) => { x.from = ev.target.value; })} /></label>
                            <label className="block min-w-0"><Label info="End-of-interval stamps: an interval is excluded when From < its timestamp ≤ To. For a whole day, use 00:00 of that day and 00:00 of the next.">To</Label><input type="datetime-local" className={inputCls} value={e.to} onChange={(ev) => set(k, (x) => { x.to = ev.target.value; })} /></label>
                            <SelectField label="Cause" value={CAUSES.includes(e.cause) ? e.cause : "Other"} options={CAUSES.map((c) => ({ value: c, label: c }))} onChange={(v) => set(k, (x) => { x.cause = v; })} />
                        </div>
                        <div className="grid gap-3 mt-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                            <label className="block min-w-0"><Label>Detailed reason</Label>
                                <textarea rows={2} className={`${inputCls} resize-y`} value={e.reason} placeholder="What happened, and why it is not attributable to the contractor" onChange={(ev) => set(k, (x) => { x.reason = ev.target.value; })} />
                            </label>
                            <label className="block min-w-0"><Label>Evidence / reference</Label>
                                <textarea rows={2} className={`${inputCls} resize-y`} value={e.evidence} placeholder="e.g. O&M daily report, TSO e-mail" onChange={(ev) => set(k, (x) => { x.evidence = ev.target.value; })} />
                            </label>
                        </div>
                        <div className="flex items-center gap-3 mt-2 text-100">
                            {bad ? <span className="text-destructive">“To” must be after “From”.</span> : n !== null && <span className={n ? "text-muted-foreground" : "text-[#9a5b00]"}>{n ? `${n} interval${n > 1 ? "s" : ""} of the data fall in this period` : "No interval of the loaded data falls in this period"}</span>}
                            <button type="button" className="ml-auto text-muted-foreground hover:text-destructive" onClick={() => edit((c) => { c.days.excluded.splice(k, 1); })}>Remove</button>
                        </div>
                    </div>
                );
            })}
            <div className="flex items-center gap-3 flex-wrap">
                <Btn onClick={add}>+ Add excluded period</Btn>
                {first !== undefined && last !== undefined && <span className="text-100 text-muted-foreground">Data from {minToIsoTime(first)} to {minToIsoTime(last)}</span>}
            </div>
        </Section>
    );
}

// ── Data review ────────────────────────────────────────────────────────
const VIEW_PARAMS: ParamId[] = ["POA", "GHI", "DHI", "REF", "T_AMB", "T_MOD", "E_GRID"];

/** Visible window of a set of charts; resets to the whole period when the data changes. */
export function useRange(t: number[]): [Range, (r: Range) => void] {
    const full: Range = [t[0] ?? 0, t[t.length - 1] ?? 1];
    const key = `${full[0]}-${full[1]}`;
    const [st, setSt] = useState<{ key: string; r: Range } | null>(null);
    const r = st && st.key === key ? st.r : full;
    return [r, (nr: Range) => setSt({ key, r: nr })];
}

const VIEW_COLORS = ["#0f6cbd", "#e8740c", "#2a9d8f", "#8a4fbf", "#c2407a", "#6b8e23", "#8c6d1f", "#4f6d8a", "#d4a017", "#1b3d6e", "#b5523b", "#3a9ad9"];
interface ViewOpt { id: string; label: string; param: ParamId; unit: string; avg: boolean; color: string }

/** Columns that can be drawn: every mapped sensor plus the filtered value of each parameter. */
function viewOptions(d: StepProps["d"], plan: NonNullable<StepProps["art"]>["plan"]): ViewOpt[] {
    const out: ViewOpt[] = [];
    let k = 0;
    for (const p of VIEW_PARAMS) {
        const ss = mappedSensors(d.cfg.mapping).filter((s) => s.param === p);
        if (!ss.length) continue;
        const unit = PARAMS.find((x) => x.id === p)?.unit ?? "";
        const fin = plan.final[p];
        if (fin && ss.length > 1) out.push({ id: fin, label: `${p} filtered`, param: p, unit, avg: true, color: VIEW_COLORS[k++ % VIEW_COLORS.length] });
        for (const s of ss) out.push({ id: s.name, label: s.name.replace(/ \(.*\)$/, ""), param: p, unit, avg: false, color: VIEW_COLORS[k++ % VIEW_COLORS.length] });
    }
    return out;
}
const UNIT_TITLE: Record<string, string> = { "W/m2": "Irradiance", "W/m²": "Irradiance", "ºC": "Temperature", kW: "Power" };

export function DataReview({ d, art }: Pick<StepProps, "d" | "art">) {
    const plan = art?.plan;
    const t = plan?.ds.t ?? [];
    const [range, setRange] = useRange(t);
    const opts = useMemo(() => (plan ? viewOptions(d, plan) : []), [d, plan]);
    // Default: the value used for each irradiance parameter (filtered average, or the single sensor)
    const defaults = useMemo(() => {
        const ids: string[] = [];
        for (const p of ["GHI", "POA", "DHI", "REF"] as ParamId[]) { const o = opts.find((x) => x.param === p && (x.avg || !opts.some((y) => y.param === p && y.avg))); if (o) ids.push(o.id); }
        return ids;
    }, [opts]);
    const [picked, setPicked] = useState<string[] | null>(null);
    const sel = (picked ?? defaults).filter((id) => opts.some((o) => o.id === id));
    const toggle = (id: string) => setPicked(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
    const avail = [...new Set(opts.map((o) => o.param))];
    const multi = avail.filter((p) => sensorsOf(d.cfg.mapping, p).length > 1);
    const [devParam, setDevParam] = useState<ParamId>("POA");
    const cur = multi.includes(devParam) ? devParam : multi[0];
    const sensors = cur ? mappedSensors(d.cfg.mapping).filter((s) => s.param === cur) : [];

    const status = useMemo(() => {
        if (!plan) return null;
        const sh = plan.sheet;
        const comply = sh.get(plan.comply).values;
        const exclCol = sh.cols.find((c) => c.header.endsWith("not in an excluded period"));
        const excl = exclCol?.values ?? [];
        const poa = plan.final.POA ? sh.get(plan.final.POA).values : null;
        const flags = sh.has("Problematic_Flag") ? sh.get("Problematic_Flag").values : [];
        const floor = d.cfg.thr.poaFloor || 50;
        const step = plan.ds.stepMin;
        const perDay = Math.round(1440 / step);
        const map = new Map<string, CellState>();
        const days = new Set<number>();
        plan.ds.t.forEach((m, i) => {
            const day = Math.floor((m - 1) / 1440), k = Math.floor(((m - 1) % 1440) / step);
            days.add(day);
            const p = poa?.[i];
            let s: CellState;
            if (excl[i] === 0) s = "excluded";
            else if (comply[i] === 1) s = "valid";
            else if (typeof flags[i] === "string" && (flags[i] as string).includes("Missing") && !(typeof p === "number" && p < floor)) s = "missing";
            else if (typeof p !== "number") s = "missing";
            else if (p < floor) s = "low";
            else s = "fail";
            map.set(`${day}|${k}`, s);
        });
        return { perDay, days: [...days].sort((a, b) => a - b), state: (dd: number, k: number) => map.get(`${dd}|${k}`) ?? "missing" };
    }, [plan, d.cfg.thr.poaFloor]);

    // Daily mean deviation of each sensor from the final value (daylight only)
    const dev = (() => {
        if (!plan || !cur || sensors.length < 2) return null;
        const fin = plan.final[cur];
        if (!fin) return null;
        const f = plan.sheet.get(fin).values;
        const dayOf = plan.ds.t.map((m) => Math.floor((m - 1) / 1440));
        const days = [...new Set(dayOf)].sort((a, b) => a - b);
        const irr = ["POA", "GHI", "DHI", "REF"].includes(cur);
        const vals = sensors.map((s) => {
            const v = plan.sheet.get(s.name).values;
            return days.map((dd) => {
                let a = 0, b = 0;
                dayOf.forEach((x, i) => { if (x !== dd) return; const sv = v[i], fv = f[i]; if (typeof sv === "number" && typeof fv === "number" && (!irr || fv > 50)) { a += sv; b += fv; } });
                return b ? (a / b - 1) * 100 : null;
            });
        });
        return { cats: days.map((x) => minToIso(x * 1440 + 1).slice(5).split("-").reverse().join("/")), vals };
    })();

    if (!plan || !status) return <Hint>Load the SCADA data first.</Hint>;
    const chosen = opts.filter((o) => sel.includes(o.id));
    const units = [...new Set(chosen.map((o) => o.unit))];
    const pick = (day: number) => setRange([day * 1440, (day + 1) * 1440]);
    const chip = (o: ViewOpt) => {
        const on = sel.includes(o.id);
        return (
            <button key={o.id} type="button" onClick={() => toggle(o.id)} aria-pressed={on}
                className={`inline-flex items-center gap-1.5 text-100 px-2 py-0.5 rounded-full border whitespace-nowrap ${on ? "border-foreground/40 bg-accent text-foreground" : "border-border text-muted-foreground hover:bg-accent"}`}>
                <span className="w-2.5 h-2.5 rounded-full border" style={{ background: on ? o.color : "transparent", borderColor: o.color }} />
                {o.label}
            </button>
        );
    };
    return (
        <>
            <ChartCard title="Data completeness" right={<span className="font-mono text-100 text-muted-foreground uppercase tracking-[0.08em]">One row per day · click a day to zoom</span>}>
                <Heatmap days={status.days} perDay={status.perDay} state={status.state} onPick={pick} />
            </ChartCard>
            <ChartCard title="Measurements" right={
                <div className="flex gap-2 text-100">
                    <button type="button" className="underline text-muted-foreground" onClick={() => setPicked(defaults)}>Irradiance values</button>
                    <button type="button" className="underline text-muted-foreground" onClick={() => setPicked(opts.map((o) => o.id))}>All</button>
                    <button type="button" className="underline text-muted-foreground" onClick={() => setPicked([])}>None</button>
                </div>}>
                <div className="grid gap-1.5 mb-3">
                    {avail.map((p) => (
                        <div key={p} className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-100 uppercase tracking-[0.08em] text-muted-foreground w-[62px] shrink-0">{p}</span>
                            {opts.filter((o) => o.param === p).map(chip)}
                        </div>
                    ))}
                </div>
                {units.length === 0 && <Hint>Choose at least one sensor above.</Hint>}
                {units.map((u, k) => (
                    <div key={u} className={k ? "mt-3" : ""}>
                        {units.length > 1 && <div className="text-100 font-semibold mb-1">{UNIT_TITLE[u] ?? u}</div>}
                        <TimeChart t={t} unit={u} range={range} onRange={setRange} nav={k === units.length - 1} decimals={u === "ºC" ? 1 : 0} height={units.length > 1 ? 190 : 240}
                            series={chosen.filter((o) => o.unit === u).map((o) => ({ name: o.label, color: o.color, values: plan.sheet.get(o.id).values, dash: o.avg ? "5 3" : undefined, width: o.avg ? 1.7 : 1.2 }))} />
                    </div>
                ))}
            </ChartCard>
            {dev && (
                <ChartCard title={`${cur} · daily deviation of each sensor from the filtered average`} right={
                    <div className="flex items-center gap-2">
                        {multi.length > 1 && multi.map((p) => <button key={p} type="button" onClick={() => setDevParam(p)} className={`font-mono text-100 px-2 py-0.5 rounded-full border ${p === cur ? "bg-primary border-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent"}`}>{p}</button>)}
                        <Info>Average of each sensor over the day divided by the average of the filtered value, minus 1. Irradiance uses daylight only (filtered value above 50 W/m²). A sensor that sits away from zero every day is probably soiled, misaligned or out of calibration.</Info>
                    </div>}>
                    <BarChart cats={dev.cats} bars={sensors.map((s, k) => ({ name: s.name.replace(/ \(.*\)$/, ""), color: PALETTE[k % PALETTE.length], values: dev.vals[k] }))} unit="%" decimals={1}
                        refLine={d.cfg.filters[cur!]?.method === "DAILY_MEAN" ? { value: (d.cfg.filters[cur!]!.dailyTol) * 100, label: `+${((d.cfg.filters[cur!]!.dailyTol) * 100).toFixed(0)} % tolerance` } : undefined} height={180} />
                </ChartCard>
            )}
        </>
    );
}

export function ReviewStep(props: StepProps) {
    return (
        <Section title="Data review" sub="Check the measurements">
            <Hint>Look for gaps, sensors that drift away from the others and days that fail the criteria before going on. Hover a chart to read the values; use the slider under it to zoom.</Hint>
            <DataReview d={props.d} art={props.art} />
        </Section>
    );
}

// ── Stage 2: PVsyst alignment ──────────────────────────────────────────
/** Shift (minutes) that best lines up the PVsyst irradiance with the measured POA. */
export function bestShift(pv: PvsystTable, t: number[], poa: (number | string | null)[], hourly: boolean): { shift: number; corr: number; scan: { s: number; c: number }[] } | null {
    const g = pv.cols.GlobEff;
    if (!g) return null;
    const meas = new Map<number, { s: number; n: number }>();
    t.forEach((m, i) => { const v = poa[i]; if (typeof v !== "number") return; const k = hourly ? Math.floor((m - 1) / 60) : m; const e = meas.get(k) ?? { s: 0, n: 0 }; e.s += v; e.n++; meas.set(k, e); });
    const step = hourly ? 60 : Math.max(pv.stepMin, 5);
    const scan: { s: number; c: number }[] = [];
    for (let s = -3 * 60; s <= 3 * 60; s += step) {
        const xs: number[] = [], ys: number[] = [];
        pv.t.forEach((m, i) => { const v = g[i]; if (typeof v !== "number") return; const k = hourly ? Math.floor((m + s) / 60) : m + s; const e = meas.get(k); if (!e) return; xs.push(e.s / e.n); ys.push(v); });
        if (xs.length < 10) continue;
        const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
        let sxy = 0, sxx = 0, syy = 0;
        xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
        scan.push({ s, c: sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0 });
    }
    if (!scan.length) return null;
    const best = scan.reduce((a, b) => (b.c > a.c + 1e-9 || (Math.abs(b.c - a.c) <= 1e-9 && Math.abs(b.s) < Math.abs(a.s)) ? b : a));
    return { shift: best.s, corr: best.c, scan };
}

export function AlignmentCharts({ d, edit, art }: Pick<StepProps, "d" | "edit" | "art">) {
    const epi = art?.epi;
    const comp = epi?.comp;
    const t = useMemo(() => (comp ? (comp.get("Date").values as number[]).map((v) => Math.round(v * 1440)) : []), [comp]);
    const [range, setRange] = useRange(t);
    const hourly = d.cfg.epi.aggregateByHour;
    const plan = art?.plan, pv = d.pvsyst;
    const suggestion = useMemo(() => (pv && plan?.final.POA ? bestShift(pv, plan.ds.t, plan.sheet.get(plan.final.POA).values, hourly) : null), [pv, plan, hourly]);
    if (!pv || !comp) return null;
    const none = !comp.n;
    const shift = d.cfg.epi.timeShiftMin;
    const step = hourly ? 60 : d.pvsyst?.stepMin ?? 15;
    const cur = suggestion?.scan.find((x) => x.s === shift);
    return (
        <Section title="Alignment check" sub="Measured vs PVsyst, with the current time shift">
            <div className="flex flex-wrap items-end gap-3 mb-3">
                <div className="w-[210px]"><NumField label="PVsyst time shift" suffix="min" commitOnBlur value={shift} onChange={(v) => edit((c) => { c.epi.timeShiftMin = v; })}
                    info={<>Minutes added to the PVsyst timestamps before they are matched with the SCADA data. Change it until the PVsyst irradiance peak sits on the measured one.<span className="ex">Example: PVsyst labels 10:00 for the hour 10:00–11:00, the SCADA stamps 11:00 at the end of it. If the PVsyst curve is one hour early, use +60.</span></>} /></div>
                <div className="flex gap-1.5">
                    <Btn onClick={() => edit((c) => { c.epi.timeShiftMin -= step; })}>− {step} min</Btn>
                    <Btn onClick={() => edit((c) => { c.epi.timeShiftMin += step; })}>+ {step} min</Btn>
                </div>
                {suggestion && (
                    <div className="text-200 flex items-center gap-2 flex-wrap">
                        Best fit: <b className="tabular-nums">{suggestion.shift > 0 ? "+" : ""}{suggestion.shift} min</b>
                        <span className="text-muted-foreground">(correlation {suggestion.corr.toFixed(3)}{cur && cur.s !== suggestion.shift ? `; now ${cur.c.toFixed(3)}` : ""})</span>
                        {suggestion.shift === shift ? <Pill tone="ok">Aligned</Pill> : <Btn kind="primary" onClick={() => edit((c) => { c.epi.timeShiftMin = suggestion.shift; })}>Use {suggestion.shift > 0 ? "+" : ""}{suggestion.shift} min</Btn>}
                    </div>
                )}
            </div>
            {none && <div className="border border-[#9a5b00] text-[#9a5b00] rounded-sm px-3 py-2 mb-3 text-200">No PVsyst step matches the SCADA data with a shift of {shift} min. Use a multiple of the PVsyst step ({step} min) or the best-fit button.</div>}
            {!none && comp.has("MPOA") && comp.has("ExpPOA") && (
                <ChartCard title="Irradiance: measured POA vs PVsyst GlobEff">
                    <TimeChart t={t} unit="W/m²" range={range} onRange={setRange} nav={false}
                        series={[{ name: "Measured POA", color: PALETTE[0], values: comp.get("MPOA").values }, { name: "PVsyst GlobEff (shifted)", color: PALETTE[1], values: comp.get("ExpPOA").values, dash: "5 3" }]} />
                </ChartCard>
            )}
            {!none && <ChartCard title="Power: measured vs expected (PVsyst)">
                <TimeChart t={t} unit="kW" range={range} onRange={setRange}
                    series={[
                        ...(comp.has("Meas") ? [{ name: "Measured", color: "#1b3d6e", values: comp.get("Meas").values }] : []),
                        { name: "Expected (PVsyst)", color: PALETTE[1], values: comp.get("Exp").values, dash: "5 3" },
                    ]} />
            </ChartCard>}
            {!none && <TempChart d={d} art={art} t={t} range={range} onRange={setRange} />}
            <Hint>The guaranteed energy is set in the next step (Contract) and compared in the charts of the Generate step.</Hint>
        </Section>
    );
}

/**
 * A PVsyst column and a measured column on the comparison steps (same keys
 * and time shift as the engine), e.g. PVsyst TArray vs measured T_MOD.
 */
function pvVsMeasured(d: StepProps["d"], art: StepProps["art"], pvCol: string, param: ParamId): { pv: (number | null)[]; meas: (number | null)[] } | null {
    const pv = d.pvsyst, plan = art?.plan, comp = art?.epi?.comp;
    const fin = plan?.final[param];
    if (!pv || !plan || !comp || !fin || !pv.cols[pvCol]) return null;
    const hourly = d.cfg.epi.aggregateByHour, shift = d.cfg.epi.timeShiftMin;
    const avg = (m: Map<number, { s: number; n: number }>, k: number, v: unknown) => { if (typeof v !== "number") return; const e = m.get(k) ?? { s: 0, n: 0 }; e.s += v; e.n++; m.set(k, e); };
    const gm = new Map<number, { s: number; n: number }>(), gp = new Map<number, { s: number; n: number }>();
    const mv = plan.sheet.get(fin).values;
    plan.ds.t.forEach((m, i) => avg(gm, hourly ? Math.floor((m - 1) / 60) : m, mv[i]));
    pv.t.forEach((m, i) => avg(gp, hourly ? Math.floor((m + shift) / 60) : m + shift, pv.cols[pvCol][i]));
    const keys = comp.get("Key").values as number[];
    const get = (g: Map<number, { s: number; n: number }>, k: number) => { const e = g.get(k); return e && e.n ? e.s / e.n : null; };
    return { pv: keys.map((k) => get(gp, k)), meas: keys.map((k) => get(gm, k)) };
}

function TempChart({ d, art, t, range, onRange, nav }: Pick<StepProps, "d" | "art"> & { t: number[]; range: Range; onRange: (r: Range) => void; nav?: boolean }) {
    const tm = pvVsMeasured(d, art, "TArray", "T_MOD");
    const ta = pvVsMeasured(d, art, "T_Amb", "T_AMB");
    if (!tm && !ta) return null;
    const series = [
        ...(tm ? [{ name: "Measured T_MOD", color: PALETTE[0], values: tm.meas }, { name: "PVsyst TArray", color: PALETTE[1], values: tm.pv, dash: "5 3" }] : []),
        ...(ta ? [{ name: "Measured T_AMB", color: PALETTE[2], values: ta.meas, width: 1.1 }, { name: "PVsyst T_Amb", color: PALETTE[3], values: ta.pv, dash: "5 3", width: 1.1 }] : []),
    ];
    return (
        <ChartCard title={tm ? "Temperature: PVsyst TArray vs measured module temperature" : "Temperature: PVsyst vs measured ambient"}
            right={<Info>PVsyst TArray is the cell temperature PVsyst modelled with the measured meteo; T_MOD is what the module sensor measured. A systematic gap points to the thermal model (Uc/Uv) or to the sensor position. Shown with the same time shift and resolution as the comparison.</Info>}>
            <TimeChart t={t} unit="ºC" decimals={1} range={range} onRange={onRange} nav={!!nav} series={series} />
        </ChartCard>
    );
}

/** Zoom shortcuts: whole period or one day. */
function DayPicker({ t, range, onRange, startStamps }: { t: number[]; range: Range; onRange: (r: Range) => void; startStamps?: boolean }) {
    if (!t.length) return null;
    // End-of-interval stamps: 00:00 belongs to the day before; hourly comparison steps are stamped at the start of the hour
    const days = [...new Set(t.map((m) => Math.floor((startStamps ? m : m - 1) / 1440)))];
    const full = range[0] <= t[0] && range[1] >= t[t.length - 1];
    const cls = (on: boolean) => `font-mono text-100 px-2 py-0.5 rounded-full border ${on ? "bg-primary border-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent"}`;
    return (
        <div className="flex flex-wrap gap-1.5 mb-2.5">
            <button type="button" className={cls(full)} onClick={() => onRange([t[0], t[t.length - 1]])}>All</button>
            {days.map((dd) => { const on = range[0] === dd * 1440 && range[1] === (dd + 1) * 1440; return <button key={dd} type="button" className={cls(on)} onClick={() => onRange([dd * 1440, (dd + 1) * 1440])}>{minToIso(dd * 1440 + 1).slice(5).split("-").reverse().join("/")}</button>; })}
        </div>
    );
}

const cumulative = (vals: (number | string | null)[], h: number) => { let s = 0; return vals.map((v) => { if (typeof v === "number") s += v * h; return s; }); };

// ── Results charts (generate step) ─────────────────────────────────────
export function ResultCharts({ d, art }: Pick<StepProps, "d" | "art">) {
    const epi = art?.epi, pr = art?.pr, plan = art?.plan;
    const tEpi = useMemo(() => (epi?.comp ? (epi.comp.get("Date").values as number[]).map((v) => Math.round(v * 1440)) : []), [epi]);
    const tPr = plan?.ds.t ?? [];
    const [range, setRange] = useRange(d.cfg.type === "EPI" ? tEpi : tPr);
    const [counted, setCounted] = useState(false);
    const fmtDay = (serial: number) => minToIso(serial * 1440).slice(5).split("-").reverse().join("/");
    const res = d.cfg.type === "EPI" && d.cfg.epi.aggregateByHour ? "Hourly" : `${plan?.ds.stepMin ?? 15}-minute`;
    const toggle = (
        <label className="flex items-center gap-1.5 text-100 text-muted-foreground"><input type="checkbox" checked={counted} onChange={(e) => setCounted(e.target.checked)} />only steps counted in the test</label>
    );

    if (d.cfg.type === "EPI" && epi?.daily && epi.comp.has("Meas")) {
        const c = epi.comp, sd = epi.daily;
        const bucketH = d.cfg.epi.aggregateByHour ? 1 : (plan?.ds.stepMin ?? 15) / 60;
        const col = (id: string) => c.get(id).values;
        const days = sd.get("Day").values as number[];
        const used = epi.days.selected;
        const dv = (id: string) => (sd.get(id).values as (number | string)[]).map((x, i) => (used[i] && typeof x === "number" ? x : null));
        return (
            <Section title="Charts" sub="Same data as the workbook">
                <ChartCard title={`${res} power: expected, guaranteed and measured`} right={toggle}>
                    <DayPicker t={tEpi} range={range} onRange={setRange} startStamps={d.cfg.epi.aggregateByHour} />
                    <TimeChart t={tEpi} unit="kW" range={range} onRange={setRange} nav={false}
                        series={[
                            { name: "Expected (PVsyst)", color: PALETTE[1], values: col(counted ? "VExp" : "Exp"), dash: "5 3" },
                            { name: `Guaranteed (× ${(d.cfg.epi.guaranteedEpi * d.cfg.epi.degradation * d.cfg.epi.availability).toFixed(3)})`, color: "#9aa5b1", values: col(counted ? "VGuar" : "Guar"), width: 1.6 },
                            { name: "Measured", color: "#1b3d6e", values: col(counted ? "VMeas" : "Meas") },
                        ]} />
                </ChartCard>
                {c.has("MPOA") && c.has("ExpPOA") && (
                    <ChartCard title={`${res} irradiance: measured POA vs PVsyst GlobEff`}>
                        <TimeChart t={tEpi} unit="W/m²" range={range} onRange={setRange} nav={false}
                            series={[{ name: "Measured POA", color: PALETTE[0], values: col(counted ? "VPOA" : "MPOA") }, { name: "PVsyst GlobEff", color: PALETTE[1], values: col("ExpPOA"), dash: "5 3" }]} />
                    </ChartCard>
                )}
                <TempChart d={d} art={art} t={tEpi} range={range} onRange={setRange} />
                <ChartCard title="Cumulative energy over the steps counted in the test" right={<Info>Running total of expected, guaranteed and measured energy, counting only the valid steps of the days used. The measured line must end above the guaranteed one to pass.</Info>}>
                    <TimeChart t={tEpi} unit="kWh" range={range} onRange={setRange}
                        series={[
                            { name: "Expected (PVsyst)", color: PALETTE[1], values: cumulative(col("VExp"), bucketH), dash: "5 3" },
                            { name: "Guaranteed", color: "#9aa5b1", values: cumulative(col("VGuar"), bucketH), width: 1.8 },
                            { name: "Measured", color: "#1b3d6e", values: cumulative(col("VMeas"), bucketH), width: 1.8 },
                        ]} />
                </ChartCard>
                <ChartCard title="Daily energy on the days used">
                    <BarChart cats={days.map(fmtDay)} unit="kWh" notes={days.map((_, i) => (used[i] ? null : "not used"))}
                        bars={[{ name: "Expected (PVsyst)", color: "#f2b27a", values: dv("Exp") }, { name: "Guaranteed", color: "#9aa5b1", values: dv("Guar") }, { name: "Measured", color: "#1b3d6e", values: dv("Meas") }]} />
                </ChartCard>
                {sd.has("Dev") && (
                    <ChartCard title="Daily deviation: measured vs guaranteed">
                        <BarChart cats={days.map(fmtDay)} unit="%" decimals={1} height={170}
                            bars={[{ name: "Deviation", color: PALETTE[0], values: dv("Dev").map((x) => (x === null ? null : x * 100)) }]} />
                    </ChartCard>
                )}
                <ChartCard title="Measured vs expected power (counted steps)">
                    <Scatter x={col("VExp")} y={col("VMeas")} xLabel="Expected PVsyst (kW)" yLabel="Measured (kW)" oneToOne height={280} />
                </ChartCard>
            </Section>
        );
    }
    if (d.cfg.type === "PR" && pr?.daily && plan) {
        const sh = plan.sheet, sd = pr.daily;
        const days = sd.get("Day").values as number[];
        const used = pr.days.selected;
        const usedDays = new Set(days.filter((_, i) => used[i]));
        const comply = sh.get(plan.comply).values;
        const dayCol = sh.get("Day").values as number[];
        const cnt = (i: number) => comply[i] === 1 && usedDays.has(dayCol[i]);
        const ref = sh.has("PR'_i (kW)") ? sh.get("PR'_i (kW)").values : null;
        const e = plan.eNet ? sh.get(plan.eNet).values : null;
        const month = (m: number) => new Date((m / 1440 - 25569) * 864e5).getUTCMonth();
        const design = ref ? tPr.map((m, i) => (typeof ref[i] === "number" ? (ref[i] as number) * d.cfg.pr.prDesign[month(m)] : null)) : [];
        const guar = design.map((v) => (v === null ? null : v * d.cfg.pr.ft));
        const only = <T,>(v: T[]) => (counted ? v.map((x, i) => (cnt(i) ? x : null)) : v);
        const pct = (id: string) => (sd.get(id).values as (number | string)[]).map((x) => (typeof x === "number" ? x * 100 : null));
        const stepH = plan.ds.stepMin / 60;
        const cum = (v: (number | string | null)[]) => cumulative(v.map((x, i) => (cnt(i) ? x : null)), stepH);
        return (
            <Section title="Charts" sub="Same data as the workbook">
                {ref && e && (
                    <ChartCard title={`${res} power: measured vs design and guaranteed`} right={toggle}>
                        <DayPicker t={tPr} range={range} onRange={setRange} />
                        <TimeChart t={tPr} unit="kW" range={range} onRange={setRange} nav={false}
                            series={[
                                { name: "Design (PR′ × design PR)", color: PALETTE[1], values: only(design), dash: "5 3" },
                                { name: "Guaranteed (× FT)", color: "#9aa5b1", values: only(guar), width: 1.6 },
                                { name: "Measured", color: "#1b3d6e", values: only(e) },
                            ]} />
                    </ChartCard>
                )}
                {ref && e && (
                    <ChartCard title="Cumulative energy over the intervals counted in the test">
                        <TimeChart t={tPr} unit="kWh" range={range} onRange={setRange}
                            series={[{ name: "Design", color: PALETTE[1], values: cum(design), dash: "5 3" }, { name: "Guaranteed", color: "#9aa5b1", values: cum(guar), width: 1.8 }, { name: "Measured", color: "#1b3d6e", values: cum(e), width: 1.8 }]} />
                    </ChartCard>
                )}
                <ChartCard title="Daily PR vs design PR">
                    <BarChart cats={days.map(fmtDay)} unit="%" decimals={1} notes={days.map((_, i) => (used[i] ? null : "not used"))}
                        bars={[{ name: "PR measured (day)", color: "#1b3d6e", values: pct("PRp").map((x, i) => (used[i] ? x : null)) }]}
                        lines={[{ name: "Design PR × FT", color: PALETTE[1], values: pct("PRd"), dash: "5 3" }]} />
                </ChartCard>
                {ref && e && (
                    <ChartCard title="Measured vs design power (counted intervals)">
                        <Scatter x={design.map((v, i) => (cnt(i) ? v : null))} y={e.map((v, i) => (cnt(i) ? v : null))} xLabel="Design power (kW)" yLabel="Measured (kW)" oneToOne height={280} />
                    </ChartCard>
                )}
            </Section>
        );
    }
    return null;
}
