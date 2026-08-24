//-----------------------------------------------------------------------
// Tarjeta de veredicto: CUMPLE/NO CUMPLE (run completo) + KPIs.
// Los KPIs (garantizada / medida / desviación / EPI / días válidos) se
// calculan sobre el PERIODO seleccionado arriba; el veredicto de cabecera
// sigue siendo el del run completo, que es el contractual.
//-----------------------------------------------------------------------

import type { PrSummary } from "@/lib/pr-model";
import { PASS_COLOR, FAIL_COLOR } from "@/lib/pr-model";

function Kpi({ label, value, unit, accent }: { label: string; value: string; unit: string; accent?: string }) {
    return (
        <div className="flex flex-col gap-1.5 px-5 py-1 border-r border-border last:border-r-0 first:pl-0 min-w-0">
            <div className="font-mono text-300 uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
            <div
                className="font-numeric text-hero-700 font-bold leading-tight whitespace-nowrap"
                style={accent ? { color: accent } : undefined}
            >
                {value}
                <span className="text-400 font-normal text-muted-foreground ml-1.5">{unit}</span>
            </div>
        </div>
    );
}

/** `s` = run completo (veredicto). `view` = periodo seleccionado (KPIs);
 *  si no se pasa, los KPIs son también del run completo. */
export function VerdictCard({ s, view }: { s: PrSummary; view?: PrSummary }) {
    const k = view ?? s;
    const color = s.passed ? PASS_COLOR : FAIL_COLOR;
    const kColor = k.passed ? PASS_COLOR : FAIL_COLOR;
    const word = s.passed ? "CUMPLE ✓" : "NO CUMPLE ✗";
    const aboveBelow = s.passed ? "por encima" : "por debajo";
    const deltaSign = s.deltaPct >= 0 ? "+" : "";
    const partial = k.periodStart !== s.periodStart || k.periodEnd !== s.periodEnd;

    return (
        <div className="border border-border rounded-b-md mb-6 overflow-hidden" style={{ borderTop: `3px solid ${color}` }}>
            <div className="flex items-center gap-3.5 bg-secondary px-5 py-3 border-b border-border">
                <span
                    className="font-mono text-300 font-bold tracking-[0.12em] text-white px-3 py-1 rounded-sm whitespace-nowrap"
                    style={{ background: color }}
                >
                    {word}
                </span>
                <span className="text-400 text-muted-foreground">
                    La producción medida está{" "}
                    <strong style={{ color }}>
                        {deltaSign}
                        {s.deltaPct.toFixed(2)}%
                    </strong>{" "}
                    {aboveBelow} del umbral garantizado.
                    <span className="font-mono text-200 uppercase tracking-[0.1em] opacity-70 ml-2">Run completo</span>
                </span>
            </div>
            <div className="bg-card px-5 pt-3 pb-5">
                <div className="font-mono text-200 uppercase tracking-[0.12em] text-muted-foreground mb-3">
                    {partial
                        ? `Periodo seleccionado · ${k.periodStart} → ${k.periodEnd}`
                        : "Periodo seleccionado · todo el run"}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-5">
                    <Kpi label="Producción garantizada" value={(k.guaranteedKwh / 1e6).toFixed(3)} unit="GWh" />
                    <Kpi label="Producción medida" value={(k.measuredKwh / 1e6).toFixed(3)} unit="GWh" />
                    <Kpi
                        label="Desviación"
                        value={`${k.deltaKwh >= 0 ? "+" : ""}${(k.deltaKwh / 1000).toLocaleString("es-ES", { maximumFractionDigits: 0 })}`}
                        unit="MWh"
                        accent={kColor}
                    />
                    <Kpi
                        label="EPI"
                        value={`${k.deltaPct >= 0 ? "+" : ""}${k.deltaPct.toFixed(2)}`}
                        unit="%"
                        accent={kColor}
                    />
                    <Kpi label="Días válidos" value={String(k.validDays)} unit="días" />
                </div>
            </div>
        </div>
    );
}
