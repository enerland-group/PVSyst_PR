//-----------------------------------------------------------------------
// Tarjeta de veredicto: CUMPLE/NO CUMPLE + desviación + KPIs.
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

export function VerdictCard({ s }: { s: PrSummary }) {
    const color = s.passed ? PASS_COLOR : FAIL_COLOR;
    const word = s.passed ? "CUMPLE ✓" : "NO CUMPLE ✗";
    const aboveBelow = s.passed ? "por encima" : "por debajo";
    const deltaSign = s.deltaPct >= 0 ? "+" : "";

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
                </span>
            </div>
            <div className="bg-card px-5 py-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                <Kpi label="Producción garantizada" value={(s.guaranteedKwh / 1e6).toFixed(3)} unit="GWh" />
                <Kpi label="Producción medida" value={(s.measuredKwh / 1e6).toFixed(3)} unit="GWh" />
                <Kpi
                    label="Desviación"
                    value={`${s.deltaKwh >= 0 ? "+" : ""}${(s.deltaKwh / 1000).toLocaleString("es-ES", { maximumFractionDigits: 0 })}`}
                    unit="MWh"
                    accent={color}
                />
                <Kpi label="Días válidos" value={String(s.validDays)} unit="días" />
            </div>
        </div>
    );
}
