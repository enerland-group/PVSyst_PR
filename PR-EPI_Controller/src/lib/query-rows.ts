//-----------------------------------------------------------------------
// Utilidades para convertir el resultado crudo del SDK (columns + rows)
// en objetos JS tipados, listos para construir specs de Vega-Lite inline.
//-----------------------------------------------------------------------

import type { QueryTable } from "@microsoft/fabric-app-data";

/** Limpia el nombre de columna del SDK: el motor devuelve los alias de
 *  SELECTCOLUMNS entre corchetes (p.ej. "[plant_code]") y las columnas
 *  cualificadas como "Tabla[Col]". Nos quedamos con el identificador interno.
 *  "[plant_code]" -> "plant_code"; "pr_results[ts]" -> "ts"; "plant_code" -> "plant_code". */
function cleanColumnName(n: string): string {
    const m = n.match(/\[([^\]]+)\]\s*$/);
    return (m ? m[1] : n).trim();
}

/** Convierte una QueryTable (columns + rows: unknown[][]) en array de objetos.
 *  Clava cada valor tanto en el nombre crudo del SDK como en el nombre LIMPIO
 *  (sin corchetes / sin cualificador de tabla), que es como lo leen los consumidores. */
export function rowsToObjects(table: QueryTable): Record<string, unknown>[] {
    const names = table.columns.map((c) => c.name);
    const clean = names.map(cleanColumnName);
    return table.rows.map((row) => {
        const obj: Record<string, unknown> = {};
        names.forEach((n, i) => {
            obj[n] = row[i];
            obj[clean[i]] = row[i];
        });
        return obj;
    });
}

/** number seguro (null/undefined/strings vacías → 0). */
export function num(v: unknown, fallback = 0): number {
    if (v == null || v === "") return fallback;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/** boolean tolerante (acepta bool, 1/0, "true"/"TRUE"/"1"). */
export function bool(v: unknown): boolean {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    const s = String(v ?? "").trim().toUpperCase();
    return s === "TRUE" || s === "1" || s === "VERDADERO" || s === "SI" || s === "YES";
}

/** string seguro. */
export function str(v: unknown, fallback = ""): string {
    return v == null ? fallback : String(v);
}
