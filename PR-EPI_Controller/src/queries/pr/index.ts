//-----------------------------------------------------------------------
// Factories de consultas DAX para el dashboard PR.
// Cada factory devuelve { connection, query } listo para useSemanticModelQuery.
//
// Modelo nuevo: pr_results ES la tabla por intervalo (cuartohorario/horario).
// Ya no hay tabla resumen ni pr_interval_results: el resumen/veredicto se deriva
// en cliente agregando los intervalos (ver summarizeIntervals en pr-model.ts).
//-----------------------------------------------------------------------

import plantsQuery from "./plants.dax?raw";
import intervalsQuery from "./intervals.dax?raw";

/** alias de conexión definido en fabric.generated.ts */
const connection = "prModel";

/** Escapa comillas dobles para inyección segura en literales DAX. */
function daxStr(v: string): string {
    return v.replace(/"/g, '""');
}

/** Lista de plantas con resultados PR (para el selector). */
export function plants() {
    return { connection, query: plantsQuery };
}

/** Desglose por intervalo (pr_results) de una planta. La app agrega por
 *  hora/día/semana y deriva el resumen/criterios desde estos intervalos. */
export function intervals(plantCode: string) {
    return { connection, query: intervalsQuery.replace("__PLANT__", daxStr(plantCode)) };
}
