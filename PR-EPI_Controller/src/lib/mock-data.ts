//-----------------------------------------------------------------------
// Datos de ejemplo para previsualizar el dashboard en local SIN Fabric.
// Se activan con VITE_PR_MOCK=1 (ver App.tsx). No afecta al build de deploy.
// El resumen/veredicto se deriva de estos intervalos (summarizeIntervals).
//-----------------------------------------------------------------------

import type { PrInterval } from "@/lib/pr-model";

export const MOCK_PLANTS = [{ code: "PL2", name: "Planta Demo (PL2)" }];

/** Criterios activos de la planta demo (c2,c4,c6,c9 desactivados). */
export const MOCK_ACTIVE = new Set(["c1", "c3", "c5", "c7", "c8"]);

// Intervalos horarios de marzo 2026 (28 días × 24h). Días 5 y 6 excluidos.
function mockIntervals(): PrInterval[] {
    const out: PrInterval[] = [];
    for (let d = 1; d <= 28; d++) {
        const dd = String(d).padStart(2, "0");
        const dayValid = d !== 5 && d !== 6;
        for (let h = 0; h < 24; h++) {
            const bell = Math.max(0, Math.sin(((h - 6) / 13) * Math.PI));
            const poa = 950 * bell;
            const eMed = 0.52 * poa * (dayValid ? 1 : 0.02) * (1 + ((d % 5) - 2) * 0.01);
            const eGar = 0.52 * poa * 0.97;
            const eEsp = 0.52 * poa * 1.0;
            const daytime = bell > 0.02;
            const valid = dayValid && daytime;
            const ts = `2026-03-${dd}T${String(h).padStart(2, "0")}:00:00`;

            // Criterios por intervalo (mock): inactivos siempre TRUE; activos fallan
            // en los intervalos no válidos + algún patrón para dar % variados.
            const crit: Record<string, boolean> = {
                c1: valid,                       // POA válida
                c2: true,                        // (inactivo)
                c3: valid && h !== 7,            // DHI válida (falla 1ª hora útil)
                c4: true,                        // (inactivo)
                c5: dayValid,                    // horas mínimas POA (día)
                c6: true,                        // (inactivo)
                c7: valid && !(d % 7 === 0 && daytime), // setpoint (1 día/semana limitado)
                c8: valid && !(h === 13 && d % 4 === 0), // alarma viento puntual
                c9: true,                        // (inactivo)
            };

            out.push({
                ts,
                day: `2026-03-${dd}`,
                hour: h,
                ms: Date.parse(ts),
                eMedida: eMed,
                eGarantizada: eGar,
                eEsperada: eEsp,
                poaM: poa,
                poaE: poa * 0.98,
                ghiM: poa * 0.85,
                ghiE: poa * 0.84,
                valid,
                crit,
            });
        }
    }
    return out;
}

export const MOCK_INTERVALS: PrInterval[] = mockIntervals();
