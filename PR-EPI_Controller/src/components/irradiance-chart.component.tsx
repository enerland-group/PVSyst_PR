//-----------------------------------------------------------------------
// Perfil horario, agregado en cliente desde los intervalos (ya filtrados
// por el periodo global). Dos ejes de control independientes:
//  · MODO:  "Promedio periodo" (media 0–23h del periodo) | "Un día"
//           (resolución nativa de un día; los tramos NO válidos de la
//            curva se pintan en GRIS y solo los válidos en color).
//  · VISTA: "POA/GHI" (irradiancia W/m², medida y esperada) |
//           "Energía" (kWh: medida y garantizada).
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { VegaVisual, useCssTheme, type VisualizationSpec } from "@microsoft/fabric-visuals";
import type { PrInterval } from "@/lib/pr-model";
import { hourProfile } from "@/lib/aggregate";

const POA = "#1b3d6e"; // azul marino — POA medida
const POA_E = "#7ba7dd"; // azul claro — POA esperada
const GHI = "#c2922e"; // ámbar mate — GHI medida
const GHI_E = "#e0c179"; // ámbar claro — GHI esperada
const GREY = "#9ca3af"; // tramo/intervalo NO válido (sin color)
const E_COLORS = { Medida: "#2563eb", Garantizada: "#475569" }; // energía: medida azul, garantizada slate (discontinua)
const INVALID = "No válido";

// Leyenda de irradiancia: UNA ENTRADA POR SERIE. Antes el color iba por sensor
// (POA/GHI) y medida/esperada se distinguía solo por el trazo discontinuo, cuya
// leyenda no llegaba a pintarse: en el gráfico no había forma de saber cuál era
// la medida y cuál la esperada. Ahora cada serie tiene su propio color —y sigue
// conservando el trazo, que ayuda al imprimir en blanco y negro.
const IRR_COLORS: Record<string, string> = {
    "POA medida": POA,
    "POA esperada": POA_E,
    "GHI medida": GHI,
    "GHI esperada": GHI_E,
};
const IRR_LEGEND = {
    title: "Irradiancia (W/m²)", orient: "top",
    labelFontSize: 13, titleFontSize: 13, columns: 2, symbolStrokeWidth: 2,
};

const X_AXIS = { tickMinStep: 1, format: "d", labelFontSize: 13, titleFontSize: 14 };
const Y_AXIS = { labelFontSize: 13, titleFontSize: 14 };
const T_AXIS = { format: "%H:%M", labelFontSize: 13, titleFontSize: 14 };

type View = "irr" | "energy";
type Mode = "period" | "day";

type DayPt = { t: string; y: number; serie: string; run?: string; ckey?: string; est?: string; sensor?: string; tipo?: string };
type RawPt = { t: string; y: number; valid: boolean };

/** Trocea una serie en runs de línea: un segmento (i,i+1) va en COLOR si ambos
 *  extremos son válidos, y en GRIS si alguno no lo es. Así el gris cubre solo los
 *  tramos no válidos (no hay línea gris de fondo bajo los tramos válidos). */
function splitRuns(pts: RawPt[], meta: { serie: string; sensor?: string; tipo?: string }): { grey: DayPt[]; color: DayPt[] } {
    const grey: DayPt[] = [];
    const color: DayPt[] = [];
    let ci = 0;
    let gi = 0;
    let curC: string | null = null;
    let curG: string | null = null;
    const mk = (p: RawPt, run: string): DayPt => ({ t: p.t, y: p.y, run, serie: meta.serie, sensor: meta.sensor, tipo: meta.tipo });
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (a.valid && b.valid) {
            curG = null;
            if (!curC) { ci += 1; curC = `${meta.serie}#c${ci}`; color.push(mk(a, curC)); }
            color.push(mk(b, curC));
        } else {
            curC = null;
            if (!curG) { gi += 1; curG = `${meta.serie}#g${gi}`; grey.push(mk(a, curG)); }
            grey.push(mk(b, curG));
        }
    }
    return { grey, color };
}

function buildDayEnergy(dayIv: PrInterval[]): { grey: DayPt[]; color: DayPt[]; points: DayPt[] } {
    const series: { serie: string; val: (iv: PrInterval) => number }[] = [
        { serie: "Medida", val: (iv) => iv.eMedida },
        { serie: "Garantizada", val: (iv) => iv.eGarantizada },
    ];
    const grey: DayPt[] = [];
    const color: DayPt[] = [];
    const points: DayPt[] = [];
    for (const s of series) {
        const pts: RawPt[] = dayIv.map((iv) => ({ t: iv.ts.replace(" ", "T"), y: s.val(iv), valid: iv.valid }));
        const r = splitRuns(pts, { serie: s.serie });
        grey.push(...r.grey);
        color.push(...r.color);
        for (const iv of dayIv) {
            points.push({ t: iv.ts.replace(" ", "T"), serie: s.serie, y: s.val(iv), ckey: iv.valid ? s.serie : INVALID, est: iv.valid ? "Válido" : INVALID });
        }
    }
    return { grey, color, points };
}

function buildDayIrr(dayIv: PrInterval[]): { grey: DayPt[]; color: DayPt[]; points: DayPt[] } {
    const series: { sensor: string; tipo: string; val: (iv: PrInterval) => number }[] = [
        { sensor: "POA", tipo: "medida", val: (iv) => iv.poaM },
        { sensor: "POA", tipo: "esperada", val: (iv) => iv.poaE },
        { sensor: "GHI", tipo: "medida", val: (iv) => iv.ghiM },
        { sensor: "GHI", tipo: "esperada", val: (iv) => iv.ghiE },
    ];
    const grey: DayPt[] = [];
    const color: DayPt[] = [];
    const points: DayPt[] = [];
    for (const s of series) {
        const serie = `${s.sensor} ${s.tipo}`;
        const pts: RawPt[] = dayIv.map((iv) => ({ t: iv.ts.replace(" ", "T"), y: s.val(iv), valid: iv.valid }));
        const r = splitRuns(pts, { serie, sensor: s.sensor, tipo: s.tipo });
        grey.push(...r.grey);
        color.push(...r.color);
        for (const iv of dayIv) {
            points.push({ t: iv.ts.replace(" ", "T"), serie, sensor: s.sensor, tipo: s.tipo, y: s.val(iv), ckey: iv.valid ? serie : INVALID, est: iv.valid ? "Válido" : INVALID });
        }
    }
    return { grey, color, points };
}

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
    return (
        <button
            onClick={onClick}
            className={`font-mono text-300 uppercase tracking-[0.05em] px-2.5 py-1 rounded-sm border transition-colors ${
                active ? "bg-primary border-primary text-primary-foreground" : "bg-transparent border-border text-muted-foreground hover:bg-accent"
            }`}
        >
            {children}
        </button>
    );
}

export function IrradianceChart({ intervals }: { intervals: PrInterval[] }) {
    const theme = useCssTheme();
    const [view, setView] = useState<View>("energy");
    const [mode, setMode] = useState<Mode>("period");
    const [day, setDay] = useState<string>("");

    const days = useMemo(() => Array.from(new Set(intervals.map((iv) => iv.day))).sort(), [intervals]);
    const effDay = days.includes(day) ? day : (days[days.length - 1] ?? "");
    const dayIdx = days.indexOf(effDay);

    const hp = useMemo(() => hourProfile(intervals), [intervals]);
    const dayIv = useMemo(
        () => intervals.filter((iv) => iv.day === effDay).sort((a, b) => a.ms - b.ms),
        [intervals, effDay],
    );

    const spec = useMemo<VisualizationSpec>(() => {
        // ================= MODO: UN DÍA (tramos no válidos en gris) =================
        if (mode === "day") {
            if (view === "energy") {
                const { grey, color, points } = buildDayEnergy(dayIv);
                const DASH = { field: "serie", scale: { domain: ["Medida", "Garantizada"], range: [[1, 0], [6, 4]] } };
                return {
                    resolve: { scale: { color: "independent" } },
                    layer: [
                        {
                            data: { values: grey },
                            mark: { type: "line", interpolate: "linear" },
                            encoding: {
                                x: { field: "t", type: "temporal", title: `Hora — ${effDay}`, axis: T_AXIS },
                                y: { field: "y", type: "quantitative", title: "Energía (kWh)", axis: Y_AXIS },
                                detail: { field: "run" },
                                color: { value: GREY },
                                strokeDash: { ...DASH, legend: null },
                            },
                        },
                        {
                            data: { values: color },
                            mark: { type: "line", interpolate: "linear" },
                            encoding: {
                                x: { field: "t", type: "temporal" },
                                y: { field: "y", type: "quantitative" },
                                detail: { field: "run" },
                                color: {
                                    field: "serie",
                                    legend: { title: "Energía (kWh)", orient: "top", labelFontSize: 13, titleFontSize: 13 },
                                    scale: { domain: Object.keys(E_COLORS), range: Object.values(E_COLORS) },
                                },
                                strokeDash: { ...DASH, legend: null },
                            },
                        },
                        {
                            data: { values: points },
                            mark: { type: "point", filled: true, size: 38 },
                            encoding: {
                                x: { field: "t", type: "temporal" },
                                y: { field: "y", type: "quantitative" },
                                color: { field: "ckey", legend: null, scale: { domain: [...Object.keys(E_COLORS), INVALID], range: [...Object.values(E_COLORS), GREY] } },
                                tooltip: [
                                    { field: "t", type: "temporal", title: "Hora", format: "%H:%M" },
                                    { field: "serie", title: "Serie" },
                                    { field: "y", type: "quantitative", title: "kWh", format: ".2f" },
                                    { field: "est", title: "Estado" },
                                ],
                            },
                        },
                    ],
                } as unknown as VisualizationSpec;
            }
            const { grey, color, points } = buildDayIrr(dayIv);
            const DASH = { field: "tipo", scale: { domain: ["medida", "esperada"], range: [[1, 0], [5, 3]] } };
            return {
                resolve: { scale: { color: "independent" } },
                layer: [
                    {
                        data: { values: grey },
                        mark: { type: "line", interpolate: "linear" },
                        encoding: {
                            x: { field: "t", type: "temporal", title: `Hora — ${effDay}`, axis: T_AXIS },
                            y: { field: "y", type: "quantitative", title: "W/m²", axis: Y_AXIS },
                            detail: { field: "run" },
                            color: { value: GREY },
                            strokeDash: { ...DASH, legend: null },
                        },
                    },
                    {
                        data: { values: color },
                        mark: { type: "line", interpolate: "linear" },
                        encoding: {
                            x: { field: "t", type: "temporal" },
                            y: { field: "y", type: "quantitative" },
                            detail: { field: "run" },
                            color: {
                                field: "serie",
                                legend: IRR_LEGEND,
                                scale: { domain: Object.keys(IRR_COLORS), range: Object.values(IRR_COLORS) },
                            },
                            strokeDash: { ...DASH, legend: null },
                        },
                    },
                    {
                        data: { values: points },
                        mark: { type: "point", filled: true, size: 38 },
                        encoding: {
                            x: { field: "t", type: "temporal" },
                            y: { field: "y", type: "quantitative" },
                            color: { field: "ckey", legend: null, scale: { domain: [...Object.keys(IRR_COLORS), INVALID], range: [...Object.values(IRR_COLORS), GREY] } },
                            tooltip: [
                                { field: "t", type: "temporal", title: "Hora", format: "%H:%M" },
                                { field: "sensor", title: "Sensor" },
                                { field: "tipo", title: "Tipo" },
                                { field: "y", type: "quantitative", title: "W/m²", format: ".0f" },
                                { field: "est", title: "Estado" },
                            ],
                        },
                    },
                ],
            } as unknown as VisualizationSpec;
        }

        // ================= MODO: PROMEDIO PERIODO (0–23h) =================
        if (view === "energy") {
            const values = hp.flatMap((h) => [
                { hora: h.hour, serie: "Medida", kwh: h.eMedida },
                { hora: h.hour, serie: "Garantizada", kwh: h.eGarantizada },
            ]);
            return {
                data: { values },
                mark: { type: "line", interpolate: "monotone", point: true },
                encoding: {
                    x: { field: "hora", type: "quantitative", title: "Hora del día", axis: X_AXIS },
                    y: { field: "kwh", type: "quantitative", title: "Energía media (kWh)", axis: Y_AXIS },
                    color: {
                        field: "serie",
                        legend: { title: "Energía (kWh)", orient: "top", labelFontSize: 13, titleFontSize: 13 },
                        scale: { domain: Object.keys(E_COLORS), range: Object.values(E_COLORS) },
                    },
                    strokeDash: {
                        field: "serie",
                        legend: null,
                        scale: { domain: ["Medida", "Garantizada"], range: [[1, 0], [6, 4]] },
                    },
                    tooltip: [
                        { field: "hora", title: "Hora" },
                        { field: "serie", title: "Serie" },
                        { field: "kwh", type: "quantitative", title: "kWh", format: ".1f" },
                    ],
                },
            } as unknown as VisualizationSpec;
        }
        const nz = (v: number) => (v && v > 0 ? v : null);
        const values = hp.flatMap((h) => [
            { hora: h.hour, sensor: "POA", tipo: "medida", serie: "POA medida", wm2: nz(h.poaM) },
            { hora: h.hour, sensor: "POA", tipo: "esperada", serie: "POA esperada", wm2: nz(h.poaE) },
            { hora: h.hour, sensor: "GHI", tipo: "medida", serie: "GHI medida", wm2: nz(h.ghiM) },
            { hora: h.hour, sensor: "GHI", tipo: "esperada", serie: "GHI esperada", wm2: nz(h.ghiE) },
        ]);
        return {
            data: { values },
            mark: { type: "line", interpolate: "monotone", point: true },
            encoding: {
                x: { field: "hora", type: "quantitative", title: "Hora del día", axis: X_AXIS },
                y: { field: "wm2", type: "quantitative", title: "W/m²", axis: Y_AXIS },
                color: {
                    field: "serie",
                    legend: IRR_LEGEND,
                    scale: { domain: Object.keys(IRR_COLORS), range: Object.values(IRR_COLORS) },
                },
                strokeDash: { field: "tipo", legend: null, scale: { domain: ["medida", "esperada"], range: [[1, 0], [5, 3]] } },
                detail: { field: "serie" },
                tooltip: [
                    { field: "hora", title: "Hora" },
                    { field: "sensor", title: "Sensor" },
                    { field: "tipo", title: "Tipo" },
                    { field: "wm2", type: "quantitative", title: "W/m²", format: ".0f" },
                ],
            },
        } as unknown as VisualizationSpec;
    }, [hp, dayIv, effDay, view, mode]);

    const arrowCls = "font-mono text-400 leading-none px-2 py-1 rounded-sm border border-border bg-transparent text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed";

    return (
        <div>
            <div className="flex flex-wrap gap-2 items-center mb-2 font-mono text-300 text-muted-foreground">
                <span>MODO:</span>
                <ToggleBtn active={mode === "period"} onClick={() => setMode("period")}>Promedio periodo</ToggleBtn>
                <ToggleBtn active={mode === "day"} onClick={() => setMode("day")}>Un día</ToggleBtn>
                {mode === "day" && (
                    <span className="inline-flex items-center gap-1">
                        <button className={arrowCls} onClick={() => dayIdx > 0 && setDay(days[dayIdx - 1])} disabled={dayIdx <= 0} aria-label="Día anterior">‹</button>
                        <select
                            value={effDay}
                            onChange={(e) => setDay(e.target.value)}
                            className="font-mono text-300 px-2 py-1 rounded-sm border border-border bg-transparent text-foreground"
                            aria-label="Día"
                        >
                            {days.map((d) => (
                                <option key={d} value={d}>{d}</option>
                            ))}
                        </select>
                        <button className={arrowCls} onClick={() => dayIdx < days.length - 1 && setDay(days[dayIdx + 1])} disabled={dayIdx >= days.length - 1} aria-label="Día siguiente">›</button>
                        <span className="normal-case tracking-normal text-200">· gris = no válido</span>
                    </span>
                )}
            </div>
            <div className="flex gap-2 items-center mb-3 font-mono text-300 text-muted-foreground">
                <span>VISTA:</span>
                <ToggleBtn active={view === "irr"} onClick={() => setView("irr")}>POA / GHI</ToggleBtn>
                <ToggleBtn active={view === "energy"} onClick={() => setView("energy")}>Energía</ToggleBtn>
            </div>
            <div className="border border-border border-l-4 border-l-primary bg-card rounded-r-md p-4 h-[380px]">
                <VegaVisual spec={spec} theme={theme} />
            </div>
        </div>
    );
}
