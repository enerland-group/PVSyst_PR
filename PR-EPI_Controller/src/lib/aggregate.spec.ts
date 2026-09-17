import { describe, it, expect } from "vitest";
import { bucketize, bucketCount, isSubHourly, pickGranularity, stepMinutes, normalizeResolution } from "@/lib/aggregate";
import type { PrInterval } from "@/lib/pr-model";

/** Intervalo mínimo: solo lo que miran bucketize/isSubHourly. */
function iv(ts: string, kwh: number, valid = true, irr = 0): PrInterval {
    return {
        ts,
        day: ts.slice(0, 10),
        hour: Number(ts.slice(11, 13)),
        minute: Number(ts.slice(14, 16)),
        tsKey: `${ts.slice(0, 10)}T${ts.slice(11, 16)}`,
        ms: Date.parse(ts.replace(" ", "T") + "Z"),
        eMedida: kwh,
        eGarantizada: kwh,
        eEsperada: kwh,
        poaM: irr, poaE: irr, ghiM: irr, ghiE: irr,
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

describe("normalizeResolution", () => {
    // Fila horaria colada entre cuartos. La de las 14:00 va detras solo para
    // CERRAR la hora de las 13:00: la ultima fila de la serie nunca se reparte.
    const SUCIO = [
        ...CUARTOS,
        iv("2026-09-11 13:00:00", 400, true, 800),
        iv("2026-09-11 14:00:00", 40, true, 100),
    ];
    const h13 = (xs: PrInterval[]) => xs.filter((x) => x.hour === 13);

    it("deja intacta una planta horaria", () => {
        expect(normalizeResolution(HORAS)).toBe(HORAS);
    });

    it("deja intacta una planta cuartohoraria ya limpia", () => {
        expect(normalizeResolution(CUARTOS)).toBe(CUARTOS);
    });

    it("reparte la hora suelta en cuartos y respeta el resto", () => {
        const r = normalizeResolution(SUCIO);
        expect(r).toHaveLength(9); // 4 cuartos + 4 del reparto + la cola de las 14:00
        expect(h13(r).map((x) => x.tsKey.slice(11))).toEqual(["13:00", "13:15", "13:30", "13:45"]);
    });

    it("la ENERGIA se reparte: el total no cambia", () => {
        const antes = SUCIO.reduce((a, x) => a + x.eMedida, 0);
        const r = normalizeResolution(SUCIO);
        expect(r.reduce((a, x) => a + x.eMedida, 0)).toBeCloseTo(antes, 10);
        expect(h13(r).map((x) => x.eMedida)).toEqual([100, 100, 100, 100]);
        expect(h13(r).map((x) => x.eGarantizada)).toEqual([100, 100, 100, 100]);
    });

    it("la IRRADIANCIA se repite, NO se divide", () => {
        const r = normalizeResolution(SUCIO);
        expect(h13(r).map((x) => x.poaM)).toEqual([800, 800, 800, 800]);
        expect(h13(r).map((x) => x.poaE)).toEqual([800, 800, 800, 800]);
        expect(h13(r).map((x) => x.ghiM)).toEqual([800, 800, 800, 800]);
        expect(h13(r).map((x) => x.ghiE)).toEqual([800, 800, 800, 800]);
    });

    it("replica la validez en los cuatro cuartos", () => {
        const sucio = [...CUARTOS, iv("2026-09-11 13:00:00", 400, false, 800), iv("2026-09-11 14:00:00", 40)];
        expect(h13(normalizeResolution(sucio)).every((x) => x.valid === false)).toBe(true);
    });

    it("una hora que ya tiene cuartos no se toca (su :00 es legitimo)", () => {
        expect(normalizeResolution(SUCIO).filter((x) => x.hour === 12)).toHaveLength(4);
    });

    it("no reparte la ULTIMA fila: es el borde del periodo, no suciedad", () => {
        // Cola real de FRA: el run corta a las 00:00 del dia siguiente y esa hora
        // se queda con un unico intervalo.
        const conCola = [...CUARTOS, iv("2026-09-12 00:00:00", 4, true, 0)];
        const r = normalizeResolution(conCola);
        expect(r).toHaveLength(5);
        expect(r[r.length - 1].eMedida).toBe(4);
    });

    it("tras normalizar, el paso dominante sigue siendo 15 min", () => {
        expect(stepMinutes(normalizeResolution(SUCIO))).toBe(15);
    });
});
