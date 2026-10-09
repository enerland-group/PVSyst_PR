import { describe, it, expect } from "vitest";
import { summarizeIntervals, type PrInterval } from "@/lib/pr-model";

/** Intervalo horario con medida / referencia (esperada) / garantizada. */
function iv(ts: string, med: number, ref: number, gar: number, valid = true): PrInterval {
    return {
        ts,
        day: ts.slice(0, 10),
        hour: Number(ts.slice(11, 13)),
        minute: 0,
        tsKey: `${ts.slice(0, 10)}T${ts.slice(11, 16)}`,
        ms: Date.parse(ts.replace(" ", "T") + "Z"),
        eMedida: med,
        eGarantizada: gar,
        eEsperada: ref,
        poaM: 0, poaE: 0, ghiM: 0, ghiE: 0,
        valid,
        crit: {},
    };
}

describe("summarizeIntervals · modo PR", () => {
    // P_dc = 1000 kW, PR garantizado 0,80: referencia = P_dc·POA/1000·1h
    const rows = [
        iv("2026-06-01 10:00", 680, 800, 640),
        iv("2026-06-01 11:00", 900, 1000, 800),
        iv("2026-06-01 12:00", 0, 1000, 800, false), // excluido: no cuenta
    ];

    it("PR medido = Σmedida/Σreferencia y PR garantizado = Σgarantizada/Σreferencia (solo válidos)", () => {
        const s = summarizeIntervals(rows, { testType: "PR" })!;
        expect(s.testType).toBe("PR");
        expect(s.prMeasured).toBeCloseTo(1580 / 1800, 10);
        expect(s.prGuaranteed).toBeCloseTo(0.8, 10);
        expect(s.passed).toBe(true);
    });

    it("el veredicto coincide con PR medido ≥ PR garantizado", () => {
        const bad = [iv("2026-06-01 10:00", 700, 1000, 800)];
        const s = summarizeIntervals(bad, { testType: "PR" })!;
        expect(s.prMeasured).toBeCloseTo(0.7, 10);
        expect(s.passed).toBe(false);
    });

    it("sin testType se queda en EPI", () => {
        expect(summarizeIntervals(rows)!.testType).toBe("EPI");
    });
});
