//-----------------------------------------------------------------------
// Audit de criterios IEC c1-c9 (solo activos). INFORMATIVO: únicamente el
// porcentaje de intervalos/días que cumplen cada criterio. Sin juicio de valor.
//-----------------------------------------------------------------------

import { CRITERIA, critMet, type PrSummary } from "@/lib/pr-model";

function AuditStat({ label, value, green }: { label: string; value: string; green?: boolean }) {
    return (
        <div className="flex flex-col gap-2 px-5 py-5 border-r border-border last:border-r-0 bg-secondary min-w-0">
            <div className="font-mono text-300 uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
            <div className={`font-mono text-hero-700 font-bold leading-tight whitespace-nowrap ${green ? "text-[#1a7a3c]" : "text-foreground"}`}>
                {value}
            </div>
        </div>
    );
}

export function CriteriaAudit({ s, days }: { s: PrSummary; days: { total: number; valid: number; pct: number } }) {
    const shown = CRITERIA.filter((d) => s.active.size === 0 || s.active.has(d.id));

    return (
        <div>
            <div className="grid grid-cols-2 md:grid-cols-5 border border-border rounded-md overflow-hidden mb-5">
                <AuditStat label="Intervalos totales" value={s.totalIntervals.toLocaleString("es-ES")} />
                <AuditStat label="Pasan todos los criterios" value={s.validIntervals.toLocaleString("es-ES")} green />
                <AuditStat label="Días válidos / totales" value={`${days.valid} / ${days.total}`} />
                <AuditStat label="% días válidos" value={`${days.pct.toFixed(0)}%`} green />
                <AuditStat label="Criterios activos" value={String(shown.length)} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {shown.map((d) => {
                    const { met, failed, base } = critMet(d, s);
                    const unit = d.level === "day" ? "días" : "intervalos";
                    return (
                        <div
                            key={d.id}
                            className="border border-border bg-secondary rounded-b-md p-4"
                            style={{ borderTop: "3px solid #1b3d6e" }}
                            title={`${d.tip}\n${d.norm}`}
                        >
                            <div className="font-mono text-200 tracking-[0.22em] uppercase text-primary font-bold mb-1.5">
                                Criterio {d.num}
                            </div>
                            <div className="text-400 text-muted-foreground leading-snug min-h-[44px]">{d.title}</div>
                            <div className="flex items-baseline gap-2.5 mt-3 mb-1">
                                <span className="font-mono text-hero-700 font-bold leading-none text-[#1b3d6e]">
                                    {met.toFixed(1)}%
                                </span>
                                <span className="text-300 text-muted-foreground">{unit} que cumplen</span>
                            </div>
                            <div className="font-mono text-200 text-muted-foreground mb-2.5">
                                {(base - failed).toLocaleString("es-ES")} de {base.toLocaleString("es-ES")} {unit}
                            </div>
                            <div className="h-2 bg-border rounded-full overflow-hidden">
                                <span className="block h-full rounded-full" style={{ width: `${met}%`, background: "#2e6ab5" }} />
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
