//-----------------------------------------------------------------------
// Model builder — wizard that replaces the Excel templates.
// Stage 1 (EPI): measured data → meteo for PVsyst. Stage 2: PVsyst + meter →
// comparison. PR: one stage. Output: workbooks with live formulas.
//-----------------------------------------------------------------------

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/hooks/auth.context";
import { getStore, metaOf, ProjectsPanel, SaveStatus, setStoreUser, useAutosave } from "./projects";
import type { ProjectMeta } from "../store";
import { defaultConfig, fitFilters, meterFromTable, normalizeConfig } from "../presets";
import { runModel, datasetFromSheet } from "../model";
import { readModelWorkbook } from "../workbook";
import { STEPS_EPI, STEPS_PR, type StepKey, type StepProps, type WizardData } from "./state";
import { DataStep, FilterStep, ProjectStep, SensorsStep } from "./steps-input";
import { CriteriaStep, ContractStep, ExportStep, GenerateStep, ResultsStep } from "./steps-output";
import { ExclusionsStep, ReviewStep } from "./steps-review";
import type { ModelConfig } from "../types";

function initial(): WizardData {
    return { cfg: defaultConfig("EPI"), scada: null, restored: null, restoredFrom: "", pvsyst: null, meterRaw: null };
}

export function ModelBuilder() {
    const [d, setDRaw] = useState<WizardData>(initial);
    const [cur, setCur] = useState<StepKey>("project");
    const [visited, setVisited] = useState<Set<StepKey>>(new Set(["project"]));
    const [toast, setToast] = useState("");
    const [project, setProject] = useState<ProjectMeta | null>(null);
    const { session } = useAuth();
    useEffect(() => {
        const u = (session as unknown as { user?: { email?: string; name?: string; displayName?: string } } | null)?.user;
        setStoreUser(u?.displayName || u?.name || u?.email || "");
    }, [session]);
    const openRef = useRef<HTMLInputElement>(null);

    const setD = (fn: (x: WizardData) => WizardData) => setDRaw((x) => { const y = fn(x); return { ...y, cfg: fitFilters(y.cfg) }; });
    const edit = (fn: (c: ModelConfig) => void) => setDRaw((x) => { const c = structuredClone(x.cfg); fn(c); return { ...x, cfg: fitFilters(c) }; });
    const notify = (m: string) => { setToast(m); window.setTimeout(() => setToast((t) => (t === m ? "" : t)), 6000); };

    const steps = d.cfg.type === "EPI" ? STEPS_EPI : STEPS_PR;
    const idx = Math.max(0, steps.findIndex((s) => s.k === cur));
    const go = (k: StepKey) => { setCur(k); setVisited((v) => new Set(v).add(k)); window.scrollTo({ top: 0 }); };

    // All calculations run in the engine; the workbook gets the same results as formulas.
    const cfg = useDeferredValue(d.cfg);
    const { art, err } = useMemo(() => {
        if (!d.scada && !d.restored) return { art: null, err: null };
        try {
            const meter = cfg.type === "EPI" && cfg.meter.source === "file" && d.meterRaw && cfg.meter.prodCol ? meterFromTable(d.meterRaw, cfg) : null;
            const a = runModel({
                cfg, raw: d.scada, restored: d.scada ? null : d.restored, pvsyst: d.pvsyst, meter,
                sources: { scada: d.scada?.fileNames ?? (d.restoredFrom ? [d.restoredFrom] : []), meter: d.meterRaw?.fileNames ?? [], pvsyst: d.pvsyst?.fileName ?? "" },
            });
            return { art: a, err: null };
        } catch (e) {
            return { art: null, err: (e as Error).message };
        }
    }, [cfg, d.scada, d.restored, d.restoredFrom, d.pvsyst, d.meterRaw]);

    const [saveState, markSaved] = useAutosave(d, art, project, setProject);
    const [creating, setCreating] = useState(false);

    async function saveProject() {
        setCreating(true);
        try {
            const store = getStore();
            const meta = metaOf(d, art);
            let p = await store.create(meta);
            if (d.scada) p = await store.save(p, "scada", d.scada, meta);
            if (d.pvsyst) p = await store.save(p, "pvsyst", d.pvsyst, meta);
            if (d.meterRaw) p = await store.save(p, "meter", d.meterRaw, meta);
            p = await store.save(p, "config", d.cfg, meta);
            setProject(p);
            markSaved(p, d);
            notify(`Project “${p.name}” saved in ${store.where}. From now on every change is saved automatically.`);
        } catch (e) {
            notify(`Could not save the project: ${(e as Error).message}`);
        } finally { setCreating(false); }
    }

    async function openProject(p: ProjectMeta) {
        const c = await getStore().load(p);
        const config = fitFilters(normalizeConfig(c.config));
        const nd: WizardData = { cfg: config, scada: c.scada, restored: null, restoredFrom: "", pvsyst: c.pvsyst, meterRaw: c.meter };
        setDRaw(nd);
        setProject(p);
        markSaved(p, nd);
        const list = config.type === "EPI" ? STEPS_EPI : STEPS_PR;
        const next: StepKey = !c.scada ? "data" : config.type === "EPI" ? (c.pvsyst ? "generate" : "pvexport") : "generate";
        setVisited(new Set(list.slice(0, list.findIndex((s) => s.k === next) + 1).map((s) => s.k)));
        setCur(next);
        notify(`Opened “${p.name}”.`);
    }

    async function openModel(file: File) {
        try {
            const { config: raw, dataSheet } = await readModelWorkbook(await file.arrayBuffer());
            const config = normalizeConfig(raw);
            const restored = datasetFromSheet(config, dataSheet);
            setDRaw({ cfg: config, scada: null, restored, restoredFrom: file.name, pvsyst: null, meterRaw: null });
            setProject(null);
            const next: StepKey = config.type === "EPI" ? "results" : "generate";
            const list = config.type === "EPI" ? STEPS_EPI : STEPS_PR;
            setVisited(new Set(list.slice(0, list.findIndex((s) => s.k === next) + 1).map((s) => s.k)));
            setCur(next);
            notify(`Opened ${file.name}: ${restored.ds.t.length} intervals restored.`);
        } catch (e) {
            notify(`Could not open ${file.name}: ${(e as Error).message}`);
        }
    }
    function newModel() {
        setDRaw(initial());
        setProject(null);
        setVisited(new Set(["project"]));
        setCur("project");
    }

    const props: StepProps = { d, setD, edit, art, err, go, notify };
    const View = { project: ProjectStep, data: DataStep, sensors: SensorsStep, filter: FilterStep, criteria: CriteriaStep, exclusions: ExclusionsStep, review: ReviewStep, pvexport: ExportStep, results: ResultsStep, contract: ContractStep, generate: GenerateStep }[cur];

    return (
        <div className="px-4 md:px-10 pt-7 pb-16 max-w-[1720px] mx-auto">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-[#1b3d6e] pb-3 mb-5">
                <h1 className="text-hero-800 font-bold text-foreground leading-tight">
                    {d.cfg.project.name || "New performance model"}
                    <span className="block text-300 font-normal text-muted-foreground font-mono mt-1 tracking-[0.06em]">
                        Performance model · {d.cfg.type} · {d.cfg.type === "EPI" ? "IEC 61724-3" : "IEC 61724-1"}
                        {d.restoredFrom ? ` · opened from ${d.restoredFrom}` : ""}
                    </span>
                </h1>
                <div className="flex flex-wrap items-center gap-2">
                    <SaveStatus project={project} state={creating ? { status: "saving", progress: "creating" } : saveState} onSave={() => void saveProject()} canSave={!creating && !!d.cfg.project.name.trim()} />
                    <input ref={openRef} type="file" accept=".xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void openModel(f); e.target.value = ""; }} />
                    <button type="button" onClick={() => openRef.current?.click()} className="font-mono text-200 border border-border rounded-sm px-3 py-1.5 bg-card hover:bg-accent" title="Open a model workbook saved from this app (internal version) to continue, e.g. stage 2 of an EPI test">
                        Open saved model…
                    </button>
                    <button type="button" onClick={newModel} className="font-mono text-200 border border-border rounded-sm px-3 py-1.5 bg-card hover:bg-accent">New model</button>
                </div>
            </div>

            {toast && <div role="status" className="border border-border bg-secondary rounded-md px-4 py-2.5 mb-5 font-mono text-200">{toast}</div>}

            <div className="grid gap-6 items-start grid-cols-1 md:grid-cols-[210px_minmax(0,1fr)] xl:grid-cols-[230px_minmax(0,1fr)]">
                <ol className="list-none m-0 p-0 flex md:flex-col gap-0.5 overflow-x-auto md:overflow-visible md:sticky md:top-3">
                    {steps.map((s, i) => {
                        const done = visited.has(s.k) && i < idx;
                        const on = s.k === cur;
                        return (
                            <li key={s.k} className="contents">
                                {s.stage && <span className="hidden md:block font-mono text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground px-2.5 pt-3 pb-1 first:pt-0">{s.stage}</span>}
                                <button
                                    type="button"
                                    onClick={() => go(s.k)}
                                    aria-current={on ? "step" : undefined}
                                    className={`grid grid-cols-[26px_1fr] gap-2.5 items-center text-left rounded-sm px-2.5 py-2 border whitespace-nowrap md:whitespace-normal ${on ? "border-primary bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--color-card))]" : "border-transparent hover:bg-secondary"}`}
                                >
                                    <span className={`w-6 h-6 rounded-full grid place-items-center text-200 border-[1.5px] ${on ? "bg-primary border-primary text-primary-foreground" : done ? "border-[#107c10] text-[#107c10]" : "border-border text-muted-foreground"}`}>{done ? "✓" : i + 1}</span>
                                    <span>
                                        <span className="block font-semibold text-200">{s.t}</span>
                                        <span className="hidden md:block text-100 text-muted-foreground">{s.s}</span>
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ol>

                <main className="min-w-0">
                    {err && cur !== "project" && (
                        <div className="border border-destructive text-destructive rounded-md px-4 py-2.5 mb-5 font-mono text-200">{err}</div>
                    )}
                    {cur === "project" && <ProjectsPanel current={project} onOpen={openProject} />}
                    <View {...props} />
                    <div className="flex justify-between gap-3 mt-5 flex-wrap">
                        <button type="button" disabled={idx === 0} onClick={() => go(steps[idx - 1].k)} className="border border-border bg-card rounded-sm px-4 py-2 font-semibold disabled:opacity-40">← Back</button>
                        {idx < steps.length - 1 && (
                            <button type="button" onClick={() => go(steps[idx + 1].k)} className="bg-primary text-primary-foreground rounded-sm px-4 py-2 font-semibold">
                                Continue: {steps[idx + 1].t} →
                            </button>
                        )}
                    </div>
                </main>

            </div>
        </div>
    );
}
