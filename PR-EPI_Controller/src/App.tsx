//-----------------------------------------------------------------------
// PR-EPI Controller — dashboard de Performance Ratio (IEC 61724-2).
// El detalle viene SIEMPRE por intervalo (tabla pr_results); la app agrega y deriva el resumen.
// Filtro de periodo GLOBAL (desde/hasta) aplicado a gráficas, tabla y descargas.
//-----------------------------------------------------------------------

import { useContext, useMemo, useState } from "react";
import { useSemanticModelQuery } from "@/hooks/use-semantic-model-query";
import { ThemeContext } from "@/hooks/theme.context";
import { pr } from "@/queries";
import { rowsToObjects, str } from "@/lib/query-rows";
import { summarizeIntervals, toIntervals, activeFromTable, testTypeFromTable, type TestType } from "@/lib/pr-model";
import { dayStats, dateRange, filterByDate, normalizeResolution } from "@/lib/aggregate";
import { MOCK_PLANTS, MOCK_ACTIVE, MOCK_INTERVALS } from "@/lib/mock-data";
import { downloadLatestTraceability } from "@/lib/fabric-files";
import { ENERLAND_LOGO } from "@/lib/logo";
import { Section } from "@/components/ui";
import { VerdictCard } from "@/components/verdict-card.component";
import { ProductionChart } from "@/components/daily-energy-chart.component";
import { IrradianceChart } from "@/components/irradiance-chart.component";
import { CriteriaAudit } from "@/components/criteria-audit.component";
import { DailyDetailTable } from "@/components/daily-detail-table.component";
import { ModelBuilder } from "@/model-builder/ui/ModelBuilder";

const MOCK = import.meta.env.VITE_PR_MOCK === "1";
/** Tipo de test del mock (VITE_PR_MOCK_TYPE=PR para previsualizar el modo PR). */
const MOCK_TYPE: TestType = import.meta.env.VITE_PR_MOCK_TYPE === "PR" ? "PR" : "EPI";

function App() {
    const { isDark, toggleTheme } = useContext(ThemeContext);
    const [plant, setPlant] = useState<string>("");
    const [gStart, setGStart] = useState("");
    const [gEnd, setGEnd] = useState("");
    const [xlsxMsg, setXlsxMsg] = useState("");
    const [xlsxBusy, setXlsxBusy] = useState(false);
    // Pestañas: dashboard del test PR/EPI o constructor de modelos (Excel con fórmulas)
    const [tab, setTab] = useState<"dashboard" | "builder">("dashboard");

    // 1) Plantas
    const plantsQ = useSemanticModelQuery(MOCK ? { connection: "prModel", query: "" } : pr.plants());
    const plants = useMemo(() => {
        if (MOCK) return MOCK_PLANTS;
        if (plantsQ.data?.status !== "success") return [];
        return rowsToObjects(plantsQ.data.table).map((r) => ({ code: str(r.plant_code), name: str(r.plant_name) || str(r.plant_code) }));
    }, [plantsQ.data]);
    const selected = plant || plants[0]?.code || "";

    // 2) Desglose por intervalo (pr_results). El resumen/veredicto se DERIVA de los intervalos.
    const intervalsQ = useSemanticModelQuery(selected ? pr.intervals(selected) : { connection: "prModel", query: "" });

    // normalizeResolution: la rejilla que se pinta es la del run (15 min en las
    // plantas configuradas asi, 1 h en el resto). Si se cuela alguna fila horaria
    // suelta en una planta cuartohoraria, se reparte para que todo el periodo
    // tenga el mismo paso. Memoizado: alimenta a todos los useMemo de abajo.
    const intervals = useMemo(
        () => normalizeResolution(
            MOCK
                ? MOCK_INTERVALS
                : intervalsQ.data?.status === "success" ? toIntervals(intervalsQ.data.table) : [],
        ),
        [intervalsQ.data],
    );
    const active = MOCK
        ? MOCK_ACTIVE
        : intervalsQ.data?.status === "success" ? activeFromTable(intervalsQ.data.table) : new Set<string>();
    // EPI o PR (01_Plants, columna PR-EPI → pr_results.test_type)
    const testType: TestType = MOCK
        ? MOCK_TYPE
        : intervalsQ.data?.status === "success" ? testTypeFromTable(intervalsQ.data.table) : "EPI";
    const plantName = plants.find((p) => p.code === selected)?.name ?? selected;
    const summary = useMemo(
        () => summarizeIntervals(intervals, { plantName, active, testType }),
        [intervals, plantName, active, testType],
    );

    // 3) Periodo global. Por defecto, TODO el rango disponible.
    const range = useMemo(() => dateRange(intervals), [intervals]);
    const gs = gStart || range.min;
    const ge = gEnd || range.max;
    const viewIntervals = useMemo(() => filterByDate(intervals, gs, ge), [intervals, gs, ge]);
    const emptyRange = Boolean(summary) && viewIntervals.length === 0;

    // criterios/veredicto = run completo; KPIs/gráficas/tabla/descargas = periodo seleccionado
    const days = useMemo(() => dayStats(intervals), [intervals]);

    // Resumen del periodo seleccionado: alimenta las tarjetas de KPIs
    // (garantizada / medida / desviación / EPI o PR / días válidos).
    const viewSummary = useMemo(
        () => summarizeIntervals(viewIntervals, { plantName, active, testType }),
        [viewIntervals, plantName, active, testType],
    );

    const anyError = MOCK ? undefined : plantsQ.error || intervalsQ.error;
    const loading = MOCK ? false : plantsQ.isLoading || intervalsQ.isLoading;

    async function onExportExcel() {
        if (!selected) return;
        if (MOCK) {
            setXlsxMsg("La descarga del Excel de trazabilidad solo está disponible desplegada en Fabric (OneLake).");
            return;
        }
        setXlsxBusy(true);
        try {
            await downloadLatestTraceability(selected, setXlsxMsg);
        } catch (err) {
            setXlsxMsg(`✗ ${(err as Error).message}`);
        } finally {
            setXlsxBusy(false);
        }
    }

    return (
        <div className="min-h-full bg-background text-foreground text-300">
            {/* ── Cabecera ───────────────────────────────────────── */}
            <header className="bg-[#0d2444] text-white px-6 md:px-10 py-4 flex items-center justify-between border-b-[3px] border-[#2e6ab5]">
                <div className="flex items-center gap-3">
                    <img src={ENERLAND_LOGO} alt="Enerland" className="h-9 w-auto rounded-sm bg-white/95 p-1" />
                    <span className="font-bold text-600 tracking-[0.05em]">ENERLAND GROUP</span>
                </div>
                <div className="flex items-center gap-3">
                    <div className="font-mono text-200 tracking-[0.14em] uppercase opacity-80 text-right leading-tight hidden md:block">
                        <strong className="block text-300 opacity-100">{tab === "builder" ? "PR-EPI Controller" : "Performance Ratio Test"}</strong>
                        {tab === "builder" ? "Performance model builder" : <>IEC 61724-2 {summary?.plantName ? `· ${summary.plantName}` : ""}</>}
                    </div>
                    {tab === "dashboard" && <button
                        onClick={onExportExcel}
                        disabled={!summary || xlsxBusy}
                        className="font-mono text-200 uppercase border border-white/40 rounded-sm px-3 py-1.5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Descargar el Excel de trazabilidad más reciente de la planta (OneLake)"
                    >
                        ⤓ Excel trazab.
                    </button>}
                    <button
                        onClick={toggleTheme}
                        className="font-mono text-200 uppercase border border-white/30 rounded-sm px-2.5 py-1.5 hover:bg-white/10"
                        title="Cambiar tema"
                    >
                        {isDark ? "☀ Claro" : "☾ Oscuro"}
                    </button>
                </div>
            </header>

            {/* ── Pestañas ─────────────────────────────────────────── */}
            <nav aria-label="Secciones" className="flex border-b border-border px-6 md:px-10 bg-secondary overflow-x-auto">
                {([["dashboard", "Dashboard"], ["builder", "Model builder"]] as const).map(([k, label]) => (
                    <button
                        key={k}
                        type="button"
                        onClick={() => setTab(k)}
                        aria-current={tab === k ? "page" : undefined}
                        className={`font-mono text-200 uppercase tracking-[0.12em] px-4 py-2.5 border-b-[3px] whitespace-nowrap ${tab === k ? "border-primary text-foreground font-bold" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                    >
                        {label}
                    </button>
                ))}
            </nav>

            <div hidden={tab !== "builder"}><ModelBuilder /></div>

            <div className="px-6 md:px-10 pt-7 pb-16 max-w-[1720px] mx-auto" hidden={tab !== "dashboard"}>
                {/* ── Título + selector + meta ───────────────────── */}
                <div className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-[#1b3d6e] pb-3 mb-4">
                    <h1 className="text-hero-800 font-bold text-foreground leading-tight">
                        {summary?.plantName || "PR-EPI Controller"}
                        <span className="block text-300 font-normal text-muted-foreground font-mono mt-1 tracking-[0.06em]">
                            Performance Ratio Test — IEC 61724-2
                            {summary && (
                                <span
                                    className="ml-2 px-1.5 py-0.5 rounded-sm border border-border text-200 font-bold tracking-[0.1em]"
                                    title={testType === "PR"
                                        ? "Test PR: medida frente a P_dc × POA/1000 × Δt × PR garantizado"
                                        : "Test EPI: medida frente a la esperada de PVsyst × EPI garantizado"}
                                >
                                    TEST {testType}
                                </span>
                            )}
                        </span>
                    </h1>
                    <div className="flex items-end gap-4">
                        <label className="font-mono text-200 uppercase text-muted-foreground">
                            <span className="block mb-1 tracking-[0.12em]">Planta</span>
                            <select
                                value={selected}
                                onChange={(e) => setPlant(e.target.value)}
                                className="font-mono text-300 bg-card border border-border border-l-[3px] border-l-primary rounded-r-sm px-3 py-2 outline-none focus:ring-2 focus:ring-ring text-foreground"
                            >
                                {plants.length === 0 && <option value="">—</option>}
                                {plants.map((p) => (
                                    <option key={p.code} value={p.code}>
                                        {p.name} ({p.code})
                                    </option>
                                ))}
                            </select>
                        </label>
                        {summary && (
                            <div className="text-right font-mono text-200 text-muted-foreground leading-relaxed">
                                Run:&nbsp;<strong>{summary.periodStart} → {summary.periodEnd}</strong>
                                <br />
                                Resolución:&nbsp;<strong>{summary.resolution}</strong>
                                <br />
                                Ejecutado:&nbsp;<strong>{summary.executedAt?.slice(0, 16).replace("T", " ")}</strong>
                            </div>
                        )}
                    </div>
                </div>

                {/* ── Periodo global ─────────────────────────────── */}
                {summary && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-6 font-mono text-300 bg-secondary border border-border rounded-md px-4 py-2.5">
                        <span className="uppercase tracking-[0.12em] text-muted-foreground">Periodo</span>
                        <label className="flex items-center gap-1.5">
                            Desde
                            <input type="date" value={gs} min={range.min} max={range.max} onChange={(e) => setGStart(e.target.value)}
                                className="border border-border rounded-sm px-2 py-1 bg-card text-foreground text-300" />
                        </label>
                        <label className="flex items-center gap-1.5">
                            Hasta
                            <input type="date" value={ge} min={range.min} max={range.max} onChange={(e) => setGEnd(e.target.value)}
                                className="border border-border rounded-sm px-2 py-1 bg-card text-foreground text-300" />
                        </label>
                        {(gStart || gEnd) && (
                            <button
                                onClick={() => { setGStart(""); setGEnd(""); }}
                                className="uppercase tracking-[0.05em] border border-border rounded-sm px-2.5 py-1 text-muted-foreground hover:bg-accent"
                                title="Todo el rango disponible"
                            >
                                Todo
                            </button>
                        )}
                        <span className="text-muted-foreground opacity-70">
                            {viewIntervals.length.toLocaleString("es-ES")} intervalos · aplica a KPIs, gráficas, tabla y descargas
                        </span>
                    </div>
                )}

                {xlsxMsg && (
                    <div className="border border-border bg-secondary rounded-md px-4 py-2.5 mb-6 font-mono text-300 text-muted-foreground">
                        {xlsxMsg}
                    </div>
                )}

                {anyError && (
                    <div className="border border-destructive bg-[#fdecea] text-destructive rounded-md p-4 mb-6 font-mono text-300">
                        Error al consultar Fabric: {String(anyError.message)}.
                        <br />
                        Revisa que el semantic model exponga la tabla <code>pr_results</code> (desglose por intervalo).
                    </div>
                )}
                {loading && !summary && (
                    <div className="text-muted-foreground font-mono text-300 py-10 text-center">Cargando datos de Fabric…</div>
                )}

                {emptyRange && (
                    <div className="border border-border bg-secondary rounded-md px-4 py-2.5 mb-6 font-mono text-300 text-muted-foreground">
                        El periodo seleccionado no contiene ningún intervalo. Amplía el rango o pulsa «Todo».
                    </div>
                )}

                {summary && (
                    <>
                        <VerdictCard s={summary} view={viewSummary} />

                        <Section title="Producción — barras por hora / día / semana" sub="Periodo global · agregación automática">
                            <ProductionChart intervals={viewIntervals} />
                        </Section>

                        <Section title="Perfil horario — promedio del periodo o un día" sub="POA/GHI y energía · media 0–23h o un día (no válidos en gris)">
                            <IrradianceChart intervals={viewIntervals} />
                        </Section>

                        <Section title="Auditoría de criterios IEC 61724-2" sub="Run completo · solo criterios activos">
                            <CriteriaAudit s={summary} days={days} />
                        </Section>

                        <Section title="Detalle — por días o por intervalos" sub="Periodo seleccionado · agregado en cliente">
                            <DailyDetailTable intervals={viewIntervals} testType={testType} />
                        </Section>
                    </>
                )}

                {!loading && !summary && !anyError && selected && (
                    <div className="text-muted-foreground font-mono text-300 py-10 text-center">No hay resultados PR para «{selected}».</div>
                )}
            </div>
        </div>
    );
}

export default App;
