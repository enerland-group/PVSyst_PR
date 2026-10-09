//-----------------------------------------------------------------------
// Parameter catalogue, workbook column naming and SCADA column suggestions.
//-----------------------------------------------------------------------

import type { ParamId, SensorMapping } from "./types";

export interface ParamDef {
    id: ParamId;
    unit: string;
    kind: "irr" | "temp" | "other";
    /** Shown in the filtering step (sensor aggregation). */
    filterable: boolean;
    description: string;
}

export const PARAMS: ParamDef[] = [
    { id: "GHI", unit: "W/m2", kind: "irr", filterable: true, description: "Global horizontal irradiance" },
    { id: "POA", unit: "W/m2", kind: "irr", filterable: true, description: "Plane-of-array irradiance" },
    { id: "REF", unit: "W/m2", kind: "irr", filterable: true, description: "Reflected irradiance (albedometer)" },
    { id: "DHI", unit: "W/m2", kind: "irr", filterable: true, description: "Diffuse horizontal irradiance" },
    { id: "T_AMB", unit: "ºC", kind: "temp", filterable: true, description: "Ambient temperature" },
    { id: "T_MOD", unit: "ºC", kind: "temp", filterable: true, description: "Module temperature" },
    { id: "WS", unit: "m/s", kind: "other", filterable: false, description: "Wind speed" },
    { id: "WA", unit: "-", kind: "other", filterable: false, description: "Wind alarm / stow (1 = alarm)" },
    { id: "E_GRID", unit: "kW", kind: "other", filterable: false, description: "Meter production (or net)" },
    { id: "E_IMP", unit: "kW", kind: "other", filterable: false, description: "Meter consumption (import)" },
    { id: "SETPOINT", unit: "kW", kind: "other", filterable: false, description: "PPC active power setpoint" },
    { id: "PF", unit: "-", kind: "other", filterable: false, description: "Power factor" },
];

export const PARAM_BY_ID: Record<ParamId, ParamDef> = Object.fromEntries(PARAMS.map((p) => [p.id, p])) as Record<ParamId, ParamDef>;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "POA 01 (W/m2)" */
export function sensorName(p: ParamId, n: number): string {
    return `${p} ${pad2(n)} (${PARAM_BY_ID[p].unit})`;
}
/** Short id used in albedo pairs and UI: "POA 01" */
export function sensorShort(p: ParamId, n: number): string {
    return `${p} ${pad2(n)}`;
}

export interface MappedSensor {
    raw: string;
    param: ParamId;
    n: number;
    name: string;  // workbook column name
    short: string; // "POA 01"
}

/** Numbered sensors in parameter order (GHI, POA, …) then SCADA order. */
export function mappedSensors(mapping: SensorMapping[]): MappedSensor[] {
    const out: MappedSensor[] = [];
    for (const p of PARAMS) {
        let n = 0;
        for (const m of mapping) {
            if (m.param === p.id) {
                n++;
                out.push({ raw: m.raw, param: p.id, n, name: sensorName(p.id, n), short: sensorShort(p.id, n) });
            }
        }
    }
    return out;
}

export function sensorsOf(mapping: SensorMapping[], p: ParamId): MappedSensor[] {
    return mappedSensors(mapping).filter((s) => s.param === p);
}

/** Workbook column name shown in the mapping table, in SCADA order. */
export function workbookNameFor(mapping: SensorMapping[], index: number): string {
    const m = mapping[index];
    if (!m.param) return "";
    if (m.param === "DATE") return "Date";
    let n = 0;
    for (let i = 0; i <= index; i++) if (mapping[i].param === m.param) n++;
    return sensorName(m.param, n);
}

// ── Suggestions ─────────────────────────────────────────────────────
// Ordered rules; the first match wins. Matching is on the upper-cased name.
const RULES: [RegExp, ParamId | "DATE" | null][] = [
    [/^(DATE|FECHA|TIMESTAMP|TIME|DATETIME|FECHA\s*Y\s*HORA)$/, "DATE"],
    [/ALBEDO|RATIO/, null],
    [/SETPOINT|SET\s*POINT|CONSIGNA|LIMITACI/, "SETPOINT"],
    [/WIND.*(ALARM|STOW)|STOW|ALARMA.*VIENTO/, "WA"],
    [/WIND.*SPEED|VELOCIDAD.*VIENTO|\bWS\b/, "WS"],
    [/FACTOR DE POTENCIA|POWER FACTOR|\bPF\b|COS\s*PHI|COSPHI/, "PF"],
    [/IMPORT|CONSUM/, "E_IMP"],
    [/(ACTIVE POWER|ACTIVA|POTENCIA ACTIVA|EXPORT).*\(KW\)|METER.*ACTIVE POWER/, "E_GRID"],
    [/RHI|REFLECT|REFLEJ|\bREF\b|ALBEDOMETER.*DOWN/, "REF"],
    [/\bDIF\b|DIFFUSE|DIFUSA|\bDHI\b/, "DHI"],
    [/POA|GTI|PLANE|INCLIN|TILT/, "POA"],
    [/GHI|GLOBAL HOR|GLOBAL RADIATION|HORIZONTAL/, "GHI"],
    [/MODULE TEMP|TEMP.*MOD|BACK.*TEMP|T_?MOD|TEMPERATURA.*M[OÓ]DULO|PANEL TEMP/, "T_MOD"],
    [/AIR TEMP|AMBIENT|AMBIENTE|T_?AMB/, "T_AMB"],
];

export function suggestParam(raw: string): ParamId | "DATE" | null {
    const u = raw.toUpperCase().trim();
    for (const [re, p] of RULES) if (re.test(u)) return p;
    return null;
}

/**
 * Suggested mapping. The date column is the one detected by content when the
 * files were read (dateCol), never just the first column: an index column
 * (1, 2, 3…) in column A must not become the date.
 */
export function suggestMapping(headers: string[], previous?: SensorMapping[], dateCol = -1): SensorMapping[] {
    const prev = new Map((previous ?? []).map((m) => [m.raw, m.param]));
    const out = headers.map((h, i): SensorMapping => {
        if (i === dateCol) return { raw: h, param: "DATE" };
        const p = prev.has(h) ? prev.get(h) ?? null : suggestParam(h);
        return { raw: h, param: p === "DATE" && dateCol >= 0 ? null : p };
    });
    return out;
}
