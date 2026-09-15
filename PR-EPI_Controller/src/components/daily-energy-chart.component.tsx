//-----------------------------------------------------------------------
// Producción: barras por hora / día / semana, agregadas en cliente desde los
// intervalos (ya filtrados por el periodo global). El gráfico ocupa TODO el
// ancho del contenedor: con pocos periodos las barras se ensanchan al máximo
// (sin blancos a la derecha); con muchos se comprimen hasta el grosor mínimo,
// y el eje X oculta etiquetas solapadas. TODAS las barras entran (sin scroll).
// Series: Medida + Garantizada (con leyenda). Δ% con negativos en granate.
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { VegaVisual, useCssTheme, type VisualizationSpec } from "@microsoft/fabric-visuals";
import type { PrInterval } from "@/lib/pr-model";
import { bucketize, pickGranularity, bucketCount, isSubHourly, type Gran } from "@/lib/aggregate";

const NAVY = "#1b3d6e";
const MID = "#4a82c4";
const RED = "#a82c2c";
const LEGEND = { title: "Energía (MWh)", orient: "top", labelFontSize: 13, titleFontSize: 13 };
const X_AXIS = { labelAngle: -90, labelOverlap: "greedy", labelFontSize: 13, titleFontSize: 14, title: null };
const Y_AXIS = { labelFontSize: 13, titleFontSize: 14, grid: true };
const BAR_PAD = { paddingInner: 0.04, paddingOuter: 0 }; // grupos casi pegados (+ más periodos vía maxBars)
const OFFSET_PAD = { paddingInner: 0, paddingOuter: 0 }; // las 2 barras de cada periodo, sin rendija entre ellas
// VegaVisual por defecto: grosor MÍNIMO de barra + scroll cuando no caben. Desactivamos
// ambos para que TODAS las barras se compriman y entren en el área, sin barra de scroll.
// El grosor mínimo de VegaVisual es el suelo: con muchos periodos no bajan de ahí.
const VEGA_CAPS = { disableCategoricalScroll: true, disableMinBarSize: true };

type View = "bars" | "cumulative" | "delta";
type GranMode = "auto" | Gran;
const GRAN_LABEL: Record<Gran, string> = { interval: "cuarto", hour: "hora", day: "día", week: "semana" };

// La vista por día es ilegible pasados los ~100 días: se muestran solo los N días MÁS
// RECIENTES del periodo, con 100 como techo y como valor por defecto.
// No se aplica a hora (ya limitada a spans <= 7 días) ni a semana (no satura).
// Topes de barras por agrupación: 168 = una semana por horas; 200 ~ dos días a
// 15 min. Por encima de eso las barras se solapan y el eje X es ilegible.
const MAX_HOUR_BARS = 168;
const MAX_INTERVAL_BARS = 200;

const DAY_WINDOWS = [10, 30, 100] as const;
type DayWindow = (typeof DAY_WINDOWS)[number];
const DAY_WINDOW_DEFAULT: DayWindow = 100;

function Btn({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
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

export function ProductionChart({ intervals }: { intervals: PrInterval[] }) {
    const theme = useCssTheme();
    const [granMode, setGranMode] = useState<GranMode>("day");
    const [view, setView] = useState<View>("bars");
    const [dayWindow, setDayWindow] = useState<DayWindow>(DAY_WINDOW_DEFAULT);

    // Qué agrupaciones se ofrecen depende de cuántas barras generarían, NO de
    // cuántos días abarque el periodo. Así, en cuanto el filtro global se acota a
    // una ventana corta —aunque sea de horas o de unos pocos cuartos—, el botón
    // "Cuarto" aparece; antes exigía un span de días enteros y en un periodo
    // largo no salía nunca.
    const subHourly = useMemo(() => isSubHourly(intervals), [intervals]);
    const hourBars = useMemo(() => bucketCount(intervals, "hour"), [intervals]);
    const intervalBars = useMemo(
        () => (subHourly ? bucketCount(intervals, "interval") : 0),
        [intervals, subHourly],
    );
    const allowHour = hourBars > 0 && hourBars <= MAX_HOUR_BARS;
    // El cuarto solo tiene sentido si los datos son de verdad sub-horarios: en una
    // planta horaria daría exactamente lo mismo que "hora".
    const allowInterval = subHourly && intervalBars > 0 && intervalBars <= MAX_INTERVAL_BARS;
    let effGranMode: GranMode = granMode === "hour" && !allowHour ? "day" : granMode;
    if (effGranMode === "interval" && !allowInterval) effGranMode = allowHour ? "hour" : "day";

    // 'auto' cae a semana si hay demasiadas barras, de modo que SIEMPRE quepan.
    const gran: Gran = effGranMode === "auto" ? pickGranularity(intervals) : effGranMode;
    const allBuckets = useMemo(() => bucketize(intervals, gran), [intervals, gran]);
    // Recorte a los últimos `dayWindow` días. Se aplica a las TRES vistas para que la
    // acumulada y el Δ% cuadren con las barras que se están viendo.
    const buckets = useMemo(
        () => (gran === "day" ? allBuckets.slice(-dayWindow) : allBuckets),
        [allBuckets, gran, dayWindow],
    );
    const dayTrimmed = buckets.length < allBuckets.length;

    const spec = useMemo<VisualizationSpec>(() => {
        // Todas las vistas se AJUSTAN al contenedor a ancho completo. `fit` nunca
        // desborda → nunca hay scroll; con pocos periodos las barras se ensanchan
        // para llenar todo el ancho disponible.
        const base = { autosize: { type: "fit", contains: "padding" } };
        if (view === "bars") {
            const values = buckets.flatMap((b) => [
                { x: b.label, serie: "Medida", kwh: b.eMedida / 1000, valid: b.validCount > 0 },
                { x: b.label, serie: "Garantizada", kwh: b.eGarantizada / 1000, valid: b.validCount > 0 },
            ]);
            return {
                ...base,
                data: { values },
                mark: { type: "bar" },
                encoding: {
                    x: { field: "x", type: "ordinal", sort: null, scale: BAR_PAD, axis: X_AXIS },
                    xOffset: { field: "serie", scale: OFFSET_PAD },
                    y: { field: "kwh", type: "quantitative", title: "Energía (MWh)", axis: Y_AXIS },
                    color: { field: "serie", legend: LEGEND, scale: { domain: ["Medida", "Garantizada"], range: [NAVY, MID] } },
                    opacity: { condition: { test: "datum.valid == false", value: 0.3 }, value: 1 },
                    tooltip: [
                        { field: "x", title: "Periodo" },
                        { field: "serie", title: "Serie" },
                        { field: "kwh", type: "quantitative", title: "MWh", format: ".2f" },
                    ],
                },
            } as unknown as VisualizationSpec;
        }
        if (view === "cumulative") {
            let cm = 0, cg = 0;
            const values = buckets.flatMap((b) => {
                cm += b.eMedida / 1000;
                cg += b.eGarantizada / 1000;
                return [
                    { x: b.label, serie: "Medida", kwh: cm },
                    { x: b.label, serie: "Garantizada", kwh: cg },
                ];
            });
            return {
                ...base,
                data: { values },
                mark: { type: "line", interpolate: "monotone", point: false },
                encoding: {
                    x: { field: "x", type: "ordinal", sort: null, axis: X_AXIS },
                    y: { field: "kwh", type: "quantitative", title: "Energía acumulada (MWh)", axis: Y_AXIS },
                    color: { field: "serie", legend: LEGEND, scale: { domain: ["Medida", "Garantizada"], range: [NAVY, MID] } },
                    strokeDash: { field: "serie", scale: { domain: ["Medida", "Garantizada"], range: [[1, 0], [5, 3]] }, legend: null },
                    tooltip: [
                        { field: "x", title: "Periodo" },
                        { field: "serie", title: "Serie" },
                        { field: "kwh", type: "quantitative", title: "MWh acum.", format: ".1f" },
                    ],
                },
            } as unknown as VisualizationSpec;
        }
        // delta — negativos en granate
        const values = buckets.map((b) => ({ x: b.label, delta: b.deltaPct, pos: b.deltaPct >= 0 }));
        return {
            ...base,
            data: { values },
            mark: { type: "bar" },
            encoding: {
                x: { field: "x", type: "ordinal", sort: null, scale: BAR_PAD, axis: X_AXIS },
                y: { field: "delta", type: "quantitative", title: "Δ% vs garantizada", axis: Y_AXIS },
                color: { field: "pos", legend: null, scale: { domain: [true, false], range: [NAVY, RED] } },
                tooltip: [
                    { field: "x", title: "Periodo" },
                    { field: "delta", type: "quantitative", title: "Δ%", format: "+.1f" },
                ],
            },
        } as unknown as VisualizationSpec;
    }, [buckets, view]);

    return (
        <div>
            <div className="flex flex-wrap gap-x-5 gap-y-2 items-center mb-3 font-mono text-300 text-muted-foreground">
                <span className="flex items-center gap-1.5">
                    Agrupar:
                    {allowInterval && <Btn active={effGranMode === "interval"} onClick={() => setGranMode("interval")}>Cuarto</Btn>}
                    {allowHour && <Btn active={effGranMode === "hour"} onClick={() => setGranMode("hour")}>Hora</Btn>}
                    <Btn active={effGranMode === "day"} onClick={() => setGranMode("day")}>Día</Btn>
                    <Btn active={effGranMode === "week"} onClick={() => setGranMode("week")}>Semana</Btn>
                    <span className="opacity-70">
                        ({GRAN_LABEL[gran]} · {buckets.length}{dayTrimmed ? ` de ${allBuckets.length}` : ""})
                    </span>
                </span>
                {gran === "day" && (
                    <span className="flex items-center gap-1.5">
                        Últimos días:
                        {DAY_WINDOWS.map((n) => (
                            <Btn key={n} active={dayWindow === n} onClick={() => setDayWindow(n)}>{String(n)}</Btn>
                        ))}
                    </span>
                )}
                <span className="flex items-center gap-1.5">
                    Vista:
                    <Btn active={view === "bars"} onClick={() => setView("bars")}>Barras</Btn>
                    <Btn active={view === "cumulative"} onClick={() => setView("cumulative")}>Acumulada</Btn>
                    <Btn active={view === "delta"} onClick={() => setView("delta")}>Delta %</Btn>
                </span>
            </div>
            <div className="border border-border border-l-4 border-l-primary bg-card rounded-r-md p-4 h-[380px] overflow-hidden">
                <VegaVisual spec={spec} theme={theme} capabilities={VEGA_CAPS} />
            </div>
        </div>
    );
}
