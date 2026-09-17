//-----------------------------------------------------------------------
// Tabla con toggle: "Por días" (agregado en cliente desde intervalos) o
// "Por intervalos" (cuartohorario/horario crudo). Δ negativo en rojo.
//-----------------------------------------------------------------------

import { useMemo, useState } from "react";
import { DataGrid, type GridColumnDef } from "@microsoft/fabric-datagrid";
import { useCssTheme } from "@microsoft/fabric-visuals";
import type { DataTable } from "@microsoft/fabric-visuals-core";
import type { PrInterval } from "@/lib/pr-model";
import { toDayRows } from "@/lib/aggregate";

type Mode = "days" | "intervals";

/** Alto de fila / cabecera / tope del contenedor de la rejilla (px). */
const ROW_H = 40;
const HEAD_H = 44;
const MAX_H = 560;

const estadoRenderer = (value: unknown) => {
    const ok = Boolean(value);
    return (
        <span
            className="font-mono text-100 font-bold uppercase tracking-[0.07em] px-1.5 py-0.5 rounded-sm border"
            style={
                ok
                    ? { color: "#1a7a3c", background: "#e8f5ee", borderColor: "#1a7a3c" }
                    : { color: "#616161", background: "#f5f5f5", borderColor: "#bbb" }
            }
        >
            {ok ? "Válido" : "Excl."}
        </span>
    );
};

const deltaRenderer = (value: unknown) => {
    if (value == null) return <span className="text-muted-foreground">—</span>;
    const n = Number(value);
    const pos = n >= 0;
    return (
        <span className="font-mono font-bold tabular-nums" style={{ color: pos ? "#1a7a3c" : "#a82c2c" }}>
            {pos ? "+" : ""}
            {n.toFixed(1)}%
        </span>
    );
};

/** Δ en valor absoluto (kWh/MWh), con signo y color. La unidad va en la cabecera. */
const deltaAbsRenderer = (value: unknown) => {
    if (value == null) return <span className="text-muted-foreground">—</span>;
    const n = Number(value);
    const pos = n >= 0;
    return (
        <span className="font-mono font-bold tabular-nums" style={{ color: pos ? "#1a7a3c" : "#a82c2c" }}>
            {pos ? "+" : ""}
            {n.toFixed(3)}
        </span>
    );
};

export function DailyDetailTable({ intervals }: { intervals: PrInterval[] }) {
    const theme = useCssTheme();
    const [mode, setMode] = useState<Mode>("days");
    const [filter, setFilter] = useState("");

    const { data, columns } = useMemo<{ data: DataTable; columns: GridColumnDef[] }>(() => {
        const f = filter.trim().toLowerCase();
        if (mode === "days") {
            const rows = toDayRows(intervals)
                .filter((d) => !f || d.day.toLowerCase().includes(f))
                .map((d) => [
                    d.day,
                    d.eMedida / 1000,
                    d.eGarantizada / 1000,
                    d.eEsperada / 1000,
                    d.validDay ? (d.eMedida - d.eGarantizada) / 1000 : null,
                    d.validDay ? d.deltaPct : null,
                    d.poaMedida || null,
                    d.ghiMedida || null,
                    d.validIntervals,
                    d.validDay,
                ]);
            return {
                data: {
                    columns: [
                        { name: "day", displayName: "Fecha" },
                        { name: "em", displayName: "E Medida (MWh)", format: "#,0.00" },
                        { name: "eg", displayName: "E Garantizada (MWh)", format: "#,0.00" },
                        { name: "ee", displayName: "E Esperada (MWh)", format: "#,0.00" },
                        { name: "dabs", displayName: "Δ (MWh)" },
                        { name: "delta", displayName: "Δ %" },
                        { name: "poa", displayName: "POA (W/m²)", format: "#,0" },
                        { name: "ghi", displayName: "GHI (W/m²)", format: "#,0" },
                        { name: "vi", displayName: "Int. válidos", format: "#,0" },
                        { name: "valid", displayName: "Estado" },
                    ],
                    rows,
                },
                columns: [
                    { id: "day", header: "Fecha" },
                    { id: "em", header: "E Medida (MWh)" },
                    { id: "eg", header: "E Garantizada (MWh)" },
                    { id: "ee", header: "E Esperada (MWh)" },
                    { id: "dabs", header: "Δ (MWh)", cellRenderer: deltaAbsRenderer },
                    { id: "delta", header: "Δ %", cellRenderer: deltaRenderer },
                    { id: "poa", header: "POA (W/m²)" },
                    { id: "ghi", header: "GHI (W/m²)" },
                    { id: "vi", header: "Int. válidos" },
                    { id: "valid", header: "Estado", cellRenderer: estadoRenderer },
                ],
            };
        }
        // intervals — filtra contra el texto mostrado (fecha y hora, sin la "T")
        const rows = intervals
            .filter((iv) => !f || iv.ts.replace("T", " ").toLowerCase().includes(f))
            .map((iv) => [
                iv.ts.replace("T", " ").slice(0, 16),
                iv.eMedida,
                iv.eGarantizada,
                iv.eEsperada,
                iv.valid ? iv.eMedida - iv.eGarantizada : null,
                iv.valid && iv.eGarantizada ? ((iv.eMedida - iv.eGarantizada) / iv.eGarantizada) * 100 : null,
                iv.poaM || null,
                iv.ghiM || null,
                iv.valid,
            ]);
        return {
            data: {
                columns: [
                    { name: "ts", displayName: "Instante" },
                    { name: "em", displayName: "E Medida (kWh)", format: "#,0.000" },
                    { name: "eg", displayName: "E Garantizada (kWh)", format: "#,0.000" },
                    { name: "ee", displayName: "E Esperada (kWh)", format: "#,0.000" },
                    { name: "dabs", displayName: "Δ (kWh)" },
                    { name: "delta", displayName: "Δ %" },
                    { name: "poa", displayName: "POA (W/m²)", format: "#,0" },
                    { name: "ghi", displayName: "GHI (W/m²)", format: "#,0" },
                    { name: "valid", displayName: "Estado" },
                ],
                rows,
            },
            columns: [
                { id: "ts", header: "Instante" },
                { id: "em", header: "E Medida (kWh)" },
                { id: "eg", header: "E Garantizada (kWh)" },
                { id: "ee", header: "E Esperada (kWh)" },
                { id: "dabs", header: "Δ (kWh)", cellRenderer: deltaAbsRenderer },
                { id: "delta", header: "Δ %", cellRenderer: deltaRenderer },
                { id: "poa", header: "POA (W/m²)" },
                { id: "ghi", header: "GHI (W/m²)" },
                { id: "valid", header: "Estado", cellRenderer: estadoRenderer },
            ],
        };
    }, [intervals, mode, filter]);

    // La rejilla se virtualiza (rowHeight) para no volcar al DOM las ~10.000 filas
    // de una planta cuartohoraria. El virtualizador mide su contenedor, así que la
    // altura tiene que ser DEFINIDA: con pocas filas se ajusta, con muchas topa en MAX_H.
    const gridHeight = Math.min(MAX_H, HEAD_H + data.rows.length * ROW_H);

    const Btn = ({ m, children }: { m: Mode; children: string }) => (
        <button
            onClick={() => setMode(m)}
            className={`font-mono text-200 uppercase tracking-[0.05em] px-3 py-1 rounded-sm border transition-colors ${
                mode === m ? "bg-primary border-primary text-primary-foreground" : "bg-transparent border-border text-muted-foreground hover:bg-accent"
            }`}
        >
            {children}
        </button>
    );

    return (
        <div>
            <div className="flex flex-wrap items-center gap-3 mb-3">
                <span className="font-mono text-200 text-muted-foreground flex items-center gap-2">
                    Desglose:
                    <Btn m="days">Por días</Btn>
                    <Btn m="intervals">Por intervalos</Btn>
                </span>
                <input
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={mode === "days" ? "Filtrar por fecha…" : "Filtrar por instante…"}
                    className="flex-1 min-w-[180px] px-3 py-1.5 border border-border border-l-[3px] border-l-primary rounded-r-sm font-mono text-300 bg-card outline-none focus:ring-2 focus:ring-ring"
                />
            </div>
            <div className="border border-border rounded-md overflow-hidden" style={{ height: gridHeight }}>
                <DataGrid data={data} columns={columns} theme={theme} rowHeight={ROW_H} />
            </div>
        </div>
    );
}
