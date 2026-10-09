//-----------------------------------------------------------------------
// Saved projects: list / open / delete, and automatic saving of the open
// project (configuration after each change, data when files are loaded).
//-----------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { Section } from "@/components/ui";
import { getRayfinClient } from "@/lib/rayfin-client";
import { BrowserStore, FabricStore, type DataApi, type MetaFields, type PayloadKind, type ProjectMeta, type ProjectStore } from "../store";
import type { Artifacts } from "../workbook";
import type { ImportStats } from "../import";
import type { WizardData } from "./state";
import { Btn, Hint, Pill } from "./kit";

let _store: ProjectStore | null = null;
let _user = "";
export function setStoreUser(u: string) { _user = u; }
export function getStore(): ProjectStore {
    if (!_store) {
        _store = import.meta.env.VITE_PR_MOCK === "1"
            ? new BrowserStore()
            : new FabricStore(getRayfinClient().data as unknown as DataApi, () => _user);
    }
    return _store;
}

type Art = (Artifacts & { stats: ImportStats }) | null;

/** Summary columns shown in the project list. */
export function metaOf(d: WizardData, art: Art): MetaFields {
    const c = d.cfg;
    const p = c.project;
    let result = "";
    if (c.type === "EPI" && art?.epi?.comp.has("Meas")) {
        const k = art.epi.kpi, s = art.epi.days;
        result = `${k.deviation !== null ? `${(k.deviation * 100).toFixed(2)} %` : "—"} vs guaranteed · ${s.daysSelected}/${s.daysNeeded || "—"} days · ${!s.complete ? "not complete" : k.pass ? "passed" : "not passed"}`;
    } else if (c.type === "PR" && art?.pr) {
        const k = art.pr.kpi, s = art.pr.days;
        result = `PR ${(k.prReal * 100).toFixed(2)} % vs ${(k.prGuaranteed * 100).toFixed(2)} % · ${s.daysSelected}/${s.daysNeeded || "—"} days · ${!s.complete ? "not complete" : k.pass ? "passed" : "not passed"}`;
    }
    const stage = !d.scada && !d.restored ? "Set-up" : c.type === "EPI" ? (d.pvsyst ? "Stage 2 · comparison" : "Stage 1 · measured data") : "Data loaded";
    return {
        name: (p.name || "Untitled").slice(0, 200), code: p.code.slice(0, 40) || undefined, testType: c.type, country: p.country || undefined,
        client: p.client.slice(0, 200) || undefined, procedure: c.procedure, stage, periodStart: c.periodStart || undefined, periodEnd: c.periodEnd || undefined,
        result: result.slice(0, 300) || undefined,
    };
}

export type SaveState = { status: "none" | "saving" | "saved" | "error"; at?: Date; error?: string; progress?: string };

/**
 * Keeps the open project saved. The configuration is written 1.5 s after the
 * last change; the SCADA / PVsyst / meter tables only when they change.
 */
export function useAutosave(d: WizardData, art: Art, project: ProjectMeta | null, setProject: (p: ProjectMeta) => void): [SaveState, (p: ProjectMeta, d: WizardData) => void] {
    const [state, setState] = useState<SaveState>({ status: "none" });
    const saved = useRef<{ id: string; config: string; scada: unknown; pvsyst: unknown; meter: unknown } | null>(null);
    const busy = useRef(false);
    const latest = useRef({ d, art, project });
    useEffect(() => { latest.current = { d, art, project }; });

    // Mark what is already stored (after create / open) so it is not written again
    const markSaved = (p: ProjectMeta, dd: WizardData) => { saved.current = { id: p.id, config: JSON.stringify(dd.cfg), scada: dd.scada, pvsyst: dd.pvsyst, meter: dd.meterRaw }; setState({ status: "saved", at: new Date() }); };

    useEffect(() => {
        if (!project) return;
        const timer = window.setTimeout(async function run() {
            if (busy.current) { window.setTimeout(run, 800); return; }
            const { d: cur, art: a, project: p } = latest.current;
            if (!p || !saved.current || saved.current.id !== p.id) return;
            const s = saved.current;
            const cfgText = JSON.stringify(cur.cfg);
            const todo: [PayloadKind, unknown][] = [];
            if (cur.scada !== s.scada) todo.push(["scada", cur.scada]);
            if (cur.pvsyst !== s.pvsyst) todo.push(["pvsyst", cur.pvsyst]);
            if (cur.meterRaw !== s.meter) todo.push(["meter", cur.meterRaw]);
            if (cfgText !== s.config || todo.length) todo.push(["config", cur.cfg]);
            if (!todo.length) return;
            busy.current = true;
            setState({ status: "saving", progress: todo.some(([k]) => k !== "config") ? "uploading data" : undefined });
            try {
                let np = p;
                const meta = metaOf(cur, a);
                for (const [kind, value] of todo) {
                    if (kind === "scada" && cur.restored && !cur.scada) continue; // reopened workbook: data stays in the workbook
                    np = await getStore().save(np, kind, value, meta);
                }
                saved.current = { id: np.id, config: cfgText, scada: cur.scada, pvsyst: cur.pvsyst, meter: cur.meterRaw };
                setProject(np);
                setState({ status: "saved", at: new Date() });
            } catch (e) {
                setState({ status: "error", error: (e as Error).message });
            } finally {
                busy.current = false;
            }
        }, 1500);
        return () => window.clearTimeout(timer);
    }, [d, art, project, setProject]);

    return [state, markSaved];
}

export function SaveStatus({ project, state, onSave, canSave }: { project: ProjectMeta | null; state: SaveState; onSave: () => void; canSave: boolean }) {
    if (!project) {
        return (
            <span className="flex items-center gap-2">
                <span className="font-mono text-100 text-muted-foreground uppercase tracking-[0.08em]">Not saved</span>
                <button type="button" disabled={!canSave} onClick={onSave} title={canSave ? "Save this model as a project" : "Give the project a name first"}
                    className="font-mono text-200 border border-primary text-primary rounded-sm px-3 py-1.5 bg-card hover:bg-accent disabled:opacity-40">Save project</button>
            </span>
        );
    }
    const t = state.at ? state.at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
    return (
        <span className="font-mono text-100 uppercase tracking-[0.08em] flex items-center gap-1.5" title={state.error}>
            {state.status === "saving" && <span className="text-muted-foreground">Saving{state.progress ? ` · ${state.progress}` : ""}…</span>}
            {state.status === "saved" && <span className="text-[#107c10] dark:text-[#6ccb5f]">✓ Saved {t}</span>}
            {state.status === "error" && <span className="text-destructive">Not saved · {state.error?.slice(0, 80)}</span>}
            {state.status === "none" && <span className="text-muted-foreground">Project</span>}
        </span>
    );
}

const fmtDate = (s: string) => { const d = new Date(s); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); };

/** List of saved projects, on the first step. */
export function ProjectsPanel({ current, onOpen }: { current: ProjectMeta | null; onOpen: (p: ProjectMeta) => Promise<void> }) {
    const [rows, setRows] = useState<ProjectMeta[] | null>(null);
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState("");
    const [confirm, setConfirm] = useState("");
    const [q, setQ] = useState("");
    const [open, setOpen] = useState(!current);
    const refresh = () => { getStore().list().then((r) => { setRows(r); setErr(""); }).catch((e: Error) => setErr(e.message)); };
    const curId = current?.id;
    useEffect(() => { getStore().list().then((r) => { setRows(r); setErr(""); }).catch((e: Error) => setErr(e.message)); }, [curId]);
    const list = (rows ?? []).filter((r) => !q || `${r.name} ${r.code ?? ""} ${r.client ?? ""} ${r.country ?? ""}`.toLowerCase().includes(q.toLowerCase()));
    return (
        <Section title="Saved projects" sub={rows ? `${rows.length} project${rows.length === 1 ? "" : "s"}` : "Loading…"}>
            <div className="flex flex-wrap items-center gap-2 mb-2.5">
                <button type="button" className="text-200 underline text-brand-foreground" onClick={() => setOpen(!open)}>{open ? "Hide the list" : "Show the list"}</button>
                {open && <input aria-label="Search projects" placeholder="Search name, code, client…" value={q} onChange={(e) => setQ(e.target.value)} className="px-2.5 py-1 text-200 border border-border rounded-sm bg-card min-w-[220px]" />}
                <span className="ml-auto text-100 text-muted-foreground">Saved in {getStore().where}. Every change is saved automatically once the project exists.</span>
            </div>
            {err && <div className="border border-destructive text-destructive rounded-sm px-3 py-2 mb-2 text-200">Could not read the projects: {err}</div>}
            {open && rows && (list.length === 0 ? <Hint>{rows.length ? "No project matches the search." : "No saved projects yet. Fill in the project name below and press “Save project” at the top."}</Hint> : (
                <div className="overflow-x-auto border border-border rounded-sm">
                    <table className="w-full border-collapse text-200">
                        <thead><tr>{["Project", "Type", "Stage", "Result", "Updated", ""].map((h, i) => <th key={i} className="font-mono text-100 uppercase tracking-[0.08em] text-muted-foreground text-left bg-secondary px-2.5 py-1.5 border-b border-border whitespace-nowrap">{h}</th>)}</tr></thead>
                        <tbody>
                            {list.map((r) => (
                                <tr key={r.id} className={`border-b border-border last:border-b-0 ${current?.id === r.id ? "bg-[color-mix(in_srgb,var(--color-primary)_7%,var(--color-card))]" : ""}`}>
                                    <td className="px-2.5 py-1.5"><b>{r.name}</b>{r.code && <span className="text-muted-foreground"> · {r.code}</span>}<span className="block text-100 text-muted-foreground">{[r.client, r.country, r.periodStart && `${r.periodStart} → ${r.periodEnd ?? ""}`].filter(Boolean).join(" · ")}</span></td>
                                    <td className="px-2.5 py-1.5"><Pill tone="info">{r.testType}</Pill></td>
                                    <td className="px-2.5 py-1.5 whitespace-nowrap">{r.stage}</td>
                                    <td className="px-2.5 py-1.5 text-100">{r.result ?? "—"}</td>
                                    <td className="px-2.5 py-1.5 text-100 text-muted-foreground whitespace-nowrap">{fmtDate(r.updatedAt)}{r.updatedBy && <span className="block">{r.updatedBy}</span>}</td>
                                    <td className="px-2.5 py-1.5 whitespace-nowrap text-right">
                                        {current?.id === r.id ? <Pill tone="ok">Open</Pill> : (
                                            <span className="inline-flex gap-1.5">
                                                <Btn disabled={!!busy} onClick={() => { setBusy(r.id); onOpen(r).catch((e: Error) => setErr(e.message)).finally(() => setBusy("")); }}>{busy === r.id ? "Opening…" : "Open"}</Btn>
                                                {confirm === r.id
                                                    ? <Btn disabled={!!busy} onClick={() => { setBusy(r.id); getStore().remove(r).then(refresh).catch((e: Error) => setErr(e.message)).finally(() => { setBusy(""); setConfirm(""); }); }}>Confirm delete</Btn>
                                                    : <button type="button" className="text-100 text-muted-foreground hover:text-destructive px-1" onClick={() => setConfirm(r.id)}>Delete</button>}
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ))}
        </Section>
    );
}
