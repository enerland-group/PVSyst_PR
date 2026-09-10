import { describe, it, expect } from "vitest";
import { bucketize, bucketCount, isSubHourly, pickGranularity } from "@/lib/aggregate";
import type { PrInterval } from "@/lib/pr-model";

/** Intervalo mínimo: solo lo que miran bucketize/isSubHourly. */
function iv(ts: string, kwh: number, valid = true): PrInterval {
    return {
        ts,
        day: ts.slice(0, 10),
        hour: Number(ts.slice(11, 13)),
        ms: Date.parse(ts.replace(" ", "T") + "Z"),
        eMedida: kwh,
        eGarantizada: kwh,
        eEsperada: kwh,
        poaM: 0, poaE: 0, ghiM: 0, ghiE: 0,
        valid,
        crit: {},
    };
}

const CUARTOS = [
    iv("2026-09-11 12:00:00", 10),
    iv("2026-09-11 12:15:00", 20),
    iv("2026-09-11 12:30:00", 30),
    iv("2026-09-11 12:45:00", 40),
];
const HORAS = [iv("2026-09-11 12:00:00", 100), iv("2026-09-11 13:00:00", 200)];

describe("isSubHourly", () => {
    it("detecta los cuartos por el minuto de la marca", () => {
        expect(isSubHourly(CUARTOS)).toBe(true);
    });
    it("una planta horaria no es sub-horaria", () => {
        expect(isSubHourly(HORAS)).toBe(false);
    });
});

describe("granularidad de cuarto", () => {
    it("cada intervalo es su propio bucket", () => {
        expect(bucketCount(CUARTOS, "interval")).toBe(4);
        expect(bucketCount(CUARTOS, "hour")).toBe(1);
    });

    it("no pierde energia respecto a agrupar por hora", () => {
        const porCuarto = bucketize(CUARTOS, "interval");
        const porHora = bucketize(CUARTOS, "hour");
        expect(porCuarto).toHaveLength(4);
        expect(porHora).toHaveLength(1);
        const suma = porCuarto.reduce((a, b) => a + b.eMedida, 0);
        expect(suma).toBe(100);
        expect(porHora[0].eMedida).toBe(suma);
    });

    it("etiqueta con el minuto y respeta el orden", () => {
        const b = bucketize(CUARTOS, "interval");
        expect(b.map((x) => x.label)).toEqual(["09-11 12:00", "09-11 12:15", "09-11 12:30", "09-11 12:45"]);
    });

    it("sigue contando solo los intervalos validos", () => {
        const conInvalido = [...CUARTOS.slice(0, 3), iv("2026-09-11 12:45:00", 40, false)];
        const b = bucketize(conInvalido, "interval");
        expect(b[3].eMedida).toBe(0);
        expect(b[3].validCount).toBe(0);
    });

    it("auto elige cuarto si cabe, y nunca en una planta horaria", () => {
        expect(pickGranularity(CUARTOS)).toBe("interval");
        expect(pickGranularity(HORAS)).toBe("hour");
    });

    it("auto no elige cuarto si no caben las barras", () => {
        expect(pickGranularity(CUARTOS, 3)).toBe("hour");
    });
});
