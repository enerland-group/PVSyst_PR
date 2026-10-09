//-----------------------------------------------------------------------
// Stage 1 output for EPI: measured meteo for the PVsyst re-simulation.
// Same columns and file names as the old CopySpecificTableToCSV macro.
//-----------------------------------------------------------------------

import { ColumnSheet, isNum, type Plan } from "./engine";
import { tr } from "./i18n";
import type { Val } from "./types";

export const METEO_COLS: { id: string; header: string; param: "GHI" | "T_AMB" | "ALB" | "DHI" | "POA" }[] = [
    { id: "GHI", header: "GHI (W/m2)", param: "GHI" },
    { id: "T_AMB", header: "T_AMB (ºC)", param: "T_AMB" },
    { id: "ALB", header: "ALB", param: "ALB" },
    { id: "DHI", header: "DHI (W/m2)", param: "DHI" },
    { id: "POA", header: "POA (W/m2)", param: "POA" },
];

export function buildMeteoSheet(plan: Plan): ColumnSheet {
    const s3 = plan.sheet;
    const L = tr(plan.cfg.project.lang);
    const n = s3.n;
    const s = new ColumnSheet(L.sMeteo, n);
    s.add({ id: "Date", header: "Date", kind: "formula", group: "time", values: s3.get("Date").values, numFmt: "dd/mm/yyyy hh:mm", width: 17, f: (r) => s3.xc("Date", r) });
    for (const c of METEO_COLS) {
        const src = plan.final[c.param];
        if (!src) continue;
        const ref = (r: number) => s3.xc(src, r);
        s.add({ id: c.id, header: c.header, kind: "formula", group: "result", numFmt: c.id === "ALB" ? "0.0000" : "0.00", width: 12, note: `= ${src}`, values: s3.get(src).values.map((v) => (isNum(v) ? v : "")), f: (r) => `IF(ISNUMBER(${ref(r)}),${ref(r)},"")` });
    }
    return s;
}

const fmtNum = (v: Val) => (isNum(v) ? String(Math.round(v * 1e4) / 1e4) : "");
/** Excel "General" US format used by the old macro: 4/21/2026 0:15 */
function fmtDate(serial: number): string {
    const d = new Date(Math.round((serial - 25569) * 864e5));
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Windows-1252 bytes (Latin-1 range is identical for the characters we write: º ² °). */
export function toCp1252(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[i] = c < 256 ? c : 63; }
    return out;
}

export function meteoCsv(meteo: ColumnSheet): string {
    const cols = meteo.cols;
    const lines = [cols.map((c) => c.header).join(",")];
    for (let i = 0; i < meteo.n; i++) lines.push(cols.map((c) => (c.id === "Date" ? fmtDate(c.values[i] as number) : fmtNum(c.values[i]))).join(","));
    return lines.join("\r\n") + "\r\n";
}
export function albedoCsv(meteo: ColumnSheet): string | null {
    if (!meteo.has("ALB")) return null;
    const d = meteo.get("Date"), a = meteo.get("ALB");
    const lines = ["Date,ALB"];
    for (let i = 0; i < meteo.n; i++) lines.push(`${fmtDate(d.values[i] as number)},${fmtNum(a.values[i])}`);
    return lines.join("\r\n") + "\r\n";
}

export function periodTag(plan: Plan): string {
    const t = plan.ds.t;
    const f = (m: number) => new Date((m / 1440 - 25569) * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
    return t.length ? `${f(t[0])}-${f(t[t.length - 1])}` : "";
}
