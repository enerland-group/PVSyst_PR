//-----------------------------------------------------------------------
// Modelo de dominio PR + catálogo de criterios IEC 61724-2 (c1-c9),
// alineado con scada_proc / traceability / 04_Criteria_Selection.
// Portado de config/report_template.py para replicar el informe HTML.
//-----------------------------------------------------------------------

import { rowsToObjects, num, bool, str } from "@/lib/query-rows";
import type { QueryTable } from "@microsoft/fabric-app-data";

/** Resumen de una ejecución (fila de pr_results). */
export interface PrSummary {
    runId: string;
    plantName: string;
    periodStart: string;
    periodEnd: string;
    resolution: string;
    passed: boolean;
    measuredKwh: number;
    guaranteedKwh: number;
    expectedKwh: number;
    deltaKwh: number;
    deltaPct: number;
    ratio: number;
    validDays: number;
    totalIntervals: number;
    validIntervals: number;
    /** c1..c9 → intervalos/días rechazados por ese criterio. */
    failed: Record<string, number>;
    /** set de criterios activos para la planta, p.ej. {"c1","c3",...}. */
    active: Set<string>;
    executedAt: string;
}

/** Un día (fila de pr_daily_results). */
export interface PrDaily {
    day: string;
    eMedida: number;       // kWh
    eEsperada: number;     // kWh
    eGarantizada: number;  // kWh
    poaMedida: number;     // W/m²
    poaEsperada: number;   // W/m²
    ghiMedida: number;     // W/m²
    ghiEsperada: number;   // W/m²
    validDay: boolean;
    validIntervals: number;
    deltaPct: number;
}

/** Punto del perfil horario promedio (energía media por hora del día). */
export interface PrHourly {
    hour: number;          // 0..23
    eMedida: number;       // kWh medios en esa hora
    eEsperada: number;
    eGarantizada: number;
}

/** Un intervalo (cuartohorario/horario) de pr_results (tabla por intervalo).
 *  Es la granularidad base; la app agrega a hora/día/semana y deriva el resumen. */
export interface PrInterval {
    ts: string;            // timestamp original (texto)
    day: string;           // YYYY-MM-DD
    hour: number;          // 0..23
    minute: number;        // 0..59 (0/15/30/45 en plantas cuartohorarias)
    /** Marca canónica 'YYYY-MM-DDTHH:mm'. Es la clave con la que se compara el
     *  filtro de periodo: mismo formato que un <input type="datetime-local">,
     *  así el rango se puede acotar al cuarto de hora y no solo al día. */
    tsKey: string;
    ms: number;            // epoch ms (orden / semanas)
    eMedida: number;       // kWh
    eGarantizada: number;
    eEsperada: number;
    poaM: number;          // W/m²
    poaE: number;
    ghiM: number;
    ghiE: number;
    valid: boolean;
    /** Cumplimiento por criterio en este intervalo: {c1:true, c2:false, ...}. */
    crit: Record<string, boolean>;
}

/** Descompone un ts (string ISO/‘YYYY-MM-DD HH:mm’ o Date) en partes estables,
 *  evitando saltos de zona horaria (usa los componentes literales del string). */
function tsParts(v: unknown): { ts: string; day: string; hour: number; minute: number; tsKey: string; ms: number } {
    const build = (ts: string, day: string, hour: number, minute: number, ms: number) => ({
        ts,
        day,
        hour,
        minute,
        tsKey: `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        ms,
    });
    if (typeof v === "string") {
        const norm = v.replace(" ", "T");
        // Posiciones literales: 'YYYY-MM-DD HH:mm' y 'YYYY-MM-DDTHH:mm' coinciden.
        return build(
            v,
            v.slice(0, 10),
            parseInt(v.slice(11, 13), 10) || 0,
            parseInt(v.slice(14, 16), 10) || 0,
            Date.parse(norm) || 0,
        );
    }
    const d = v instanceof Date ? v : new Date(v as number);
    const iso = isNaN(d.getTime()) ? "" : d.toISOString();
    return build(iso, iso.slice(0, 10), d.getUTCHours(), d.getUTCMinutes(), d.getTime() || 0);
}

/** Mapea filas de pr_results (por intervalo) a PrInterval[], ordenadas por tiempo. */
export function toIntervals(table: QueryTable): PrInterval[] {
    return rowsToObjects(table)
        .map((r) => {
            const p = tsParts(r.ts);
            const crit: Record<string, boolean> = {};
            for (let i = 1; i <= 9; i++) crit[`c${i}`] = bool(r[`c${i}`]);
            return {
                ts: p.ts,
                day: p.day,
                hour: p.hour,
                minute: p.minute,
                tsKey: p.tsKey,
                ms: p.ms,
                eMedida: num(r.e_medida),
                eGarantizada: num(r.e_garantizada),
                eEsperada: num(r.e_esperada),
                poaM: num(r.poa_m),
                poaE: num(r.poa_e),
                ghiM: num(r.ghi_m),
                ghiE: num(r.ghi_e),
                valid: bool(r.valid),
                crit,
            };
        })
        .sort((a, b) => a.ms - b.ms);
}

/** Lee el set de criterios activos de la columna active_criteria (igual en
 *  todas las filas). Vacío = no informado → la app mostrará todos. */
export function activeFromTable(table: QueryTable): Set<string> {
    const rows = rowsToObjects(table);
    return rows.length ? parseActive(rows[0].active_criteria) : new Set();
}

/** Nivel del criterio: por intervalo o por día (define el denominador del %). */
export type CritLevel = "interval" | "day";

export interface CritDef {
    id: string;          // "c1".."c9"
    num: string;         // "01".."09"
    level: CritLevel;
    title: string;       // título corto (puede parametrizarse con contrato)
    tip: string;         // descripción tooltip
    norm: string;        // referencia normativa
}

/** Catálogo canónico c1-c9 (mismo orden y semántica que el resto del pipeline). */
export const CRITERIA: CritDef[] = [
    { id: "c1", num: "01", level: "interval",
      title: "POA disponible y válida",
      tip: "Se excluyen los intervalos sin lectura válida del sensor POA (irradiancia en plano de módulo).",
      norm: "IEC 61724-2 · Validez del sensor POA" },
    { id: "c2", num: "02", level: "interval",
      title: "GHI disponible y válida",
      tip: "Se excluyen los intervalos sin lectura válida del sensor GHI (irradiancia horizontal global).",
      norm: "IEC 61724-2 · Validez del sensor GHI" },
    { id: "c3", num: "03", level: "interval",
      title: "DHI disponible y válida",
      tip: "Se excluyen los intervalos sin lectura válida del sensor DHI (irradiancia difusa horizontal).",
      norm: "IEC 61724-2 · Validez del sensor DHI" },
    { id: "c4", num: "04", level: "interval",
      title: "Sensor de referencia (REF) válido",
      tip: "Se excluyen los intervalos sin lectura válida de la celda/sensor de referencia (REF).",
      norm: "IEC 61724-2 · Validez del sensor de referencia" },
    { id: "c5", num: "05", level: "day",
      title: "Horas mínimas diarias de POA",
      tip: "El día solo se incluye si acumula suficientes horas con POA por encima del umbral.",
      norm: "IEC 61724-2 · Horas mínimas de irradiancia (POA)" },
    { id: "c6", num: "06", level: "day",
      title: "Horas mínimas diarias de GHI",
      tip: "El día solo se incluye si acumula suficientes horas con GHI por encima del umbral.",
      norm: "IEC 61724-2 · Horas mínimas de irradiancia (GHI)" },
    { id: "c7", num: "07", level: "interval",
      title: "Sin limitación de setpoint",
      tip: "Se excluyen los intervalos con limitación de potencia del operador (setpoint por debajo del mínimo).",
      norm: "IEC 61724-2 · Restricción operativa externa" },
    { id: "c8", num: "08", level: "interval",
      title: "Sin alarma de viento",
      tip: "Se excluyen los intervalos con alarma de viento activa (seguidores en posición de bandera).",
      norm: "IEC 61724-2 · Restricción operativa externa" },
    { id: "c9", num: "09", level: "interval",
      title: "Factor de potencia en rango",
      tip: "Se excluyen los intervalos con factor de potencia fuera del rango admisible.",
      norm: "Validez eléctrica del punto de medida" },
];

/** Parsea el string "c1,c3,c5" (columna active_criteria) a un Set. */
export function parseActive(v: unknown): Set<string> {
    const s = str(v).trim();
    if (!s) return new Set();
    return new Set(
        s.split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean),
    );
}

/** Moda (valor más frecuente) de una lista de números. */
function modeOf(nums: number[]): number {
    if (!nums.length) return 0;
    const m = new Map<number, number>();
    let best = nums[0], bestN = 0;
    for (const n of nums) {
        const c = (m.get(n) ?? 0) + 1;
        m.set(n, c);
        if (c > bestN) { bestN = c; best = n; }
    }
    return best;
}

/** Deriva el resumen PR (PrSummary) agregando los intervalos EN CLIENTE.
 *  Sustituye a la antigua fila-resumen de pr_results.
 *  - Totales y veredicto: sobre intervalos válidos.
 *  - failed[cN]: nº de intervalos donde el criterio cN NO se cumple.
 *  - resolución: paso temporal más frecuente entre intervalos. */
export function summarizeIntervals(
    intervals: PrInterval[],
    opts: { plantName?: string; active?: Set<string>; runId?: string; executedAt?: string } = {},
): PrSummary | undefined {
    if (!intervals.length) return undefined;

    let measuredKwh = 0, guaranteedKwh = 0, expectedKwh = 0, validIntervals = 0;
    const failed: Record<string, number> = {};
    for (let i = 1; i <= 9; i++) failed[`c${i}`] = 0;
    const validDays = new Set<string>();
    const diffs: number[] = [];
    let prevMs = NaN;

    for (const iv of intervals) {
        if (iv.valid) {
            measuredKwh += iv.eMedida;
            guaranteedKwh += iv.eGarantizada;
            expectedKwh += iv.eEsperada;
            validIntervals += 1;
            validDays.add(iv.day);
        }
        for (let i = 1; i <= 9; i++) if (iv.crit[`c${i}`] === false) failed[`c${i}`] += 1;
        if (!Number.isNaN(prevMs)) {
            const d = iv.ms - prevMs;
            if (d > 0) diffs.push(d);
        }
        prevMs = iv.ms;
    }

    const deltaKwh = measuredKwh - guaranteedKwh;
    const mins = Math.round(modeOf(diffs) / 60000);
    const resolution = mins >= 60 && mins % 60 === 0
        ? `${mins / 60}:00:00`
        : mins > 0 ? `0:${String(mins).padStart(2, "0")}:00` : "";

    return {
        runId: opts.runId ?? "",
        plantName: opts.plantName ?? "",
        periodStart: intervals[0].day,
        periodEnd: intervals[intervals.length - 1].day,
        resolution,
        passed: measuredKwh >= guaranteedKwh,
        measuredKwh,
        guaranteedKwh,
        expectedKwh,
        deltaKwh,
        deltaPct: guaranteedKwh ? (deltaKwh / guaranteedKwh) * 100 : 0,
        ratio: guaranteedKwh ? measuredKwh / guaranteedKwh : 0,
        validDays: validDays.size,
        totalIntervals: intervals.length,
        validIntervals,
        failed,
        active: opts.active ?? new Set(),
        executedAt: opts.executedAt ?? "",
    };
}

// Nota: el desglose diario y el perfil horario ya NO se leen de tablas
// (pr_daily_results / hourly). Se calculan en cliente desde los intervalos
// (ver toDayRows y hourProfile en aggregate.ts).

/** % de intervalos/días que CUMPLEN un criterio, dado su nivel.
 *  failed se acota a [0, base] para que el % quede siempre en [0, 100]. */
export function critMet(def: CritDef, s: PrSummary): { met: number; failed: number; base: number; rejPct: number } {
    const rawFailed = s.failed[def.id] ?? 0;
    const totalDays = s.validDays; // base aproximada por día
    const base = def.level === "day" ? Math.max(totalDays + rawFailed, 1) : Math.max(s.totalIntervals, 1);
    const failed = Math.max(0, Math.min(rawFailed, base));
    const met = Math.round(((base - failed) / base) * 1000) / 10;
    const rejPct = (failed / base) * 100;
    return { met, failed, base, rejPct };
}

/** Verdict de color/estado. */
export const PASS_COLOR = "#1a7a3c";
export const FAIL_COLOR = "#a82c2c"; // granate mate
export const NAVY = "#1b3d6e";
export const NAVY_MID = "#2e6ab5";
export const GREEN = "#1a7a3c";
export const ORANGE = "#e65100";
