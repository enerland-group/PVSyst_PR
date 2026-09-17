//-----------------------------------------------------------------------
// Agregación en cliente desde datos por intervalo (tabla pr_results).
// La granularidad base es siempre cuartohoraria/horaria; aquí agregamos a
// hora / día / semana para el gráfico de barras, perfil horario y tabla.
//-----------------------------------------------------------------------

import type { PrInterval, PrDaily } from "@/lib/pr-model";

export type Gran = "interval" | "hour" | "day" | "week";

export interface Bucket {
    key: string;
    label: string;
    ms: number;
    eMedida: number;
    eGarantizada: number;
    eEsperada: number;
    validCount: number;
    deltaPct: number;
}

/** Lunes de la semana (estable en UTC) a partir de un día 'YYYY-MM-DD'. */
function weekStartFromDay(day: string): { key: string; label: string } {
    const [y, m, d] = day.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dow = dt.getUTCDay(); // 0=Dom..6=Sáb
    const diff = (dow + 6) % 7; // días desde el lunes
    dt.setUTCDate(dt.getUTCDate() - diff);
    const iso = dt.toISOString().slice(0, 10);
    return { key: iso, label: `Sem. ${iso.slice(5)}` };
}

/** Rango de fechas (YYYY-MM-DD) cubierto por los intervalos. */
export function dateRange(intervals: PrInterval[]): { min: string; max: string } {
    if (!intervals.length) return { min: "", max: "" };
    return { min: intervals[0].day, max: intervals[intervals.length - 1].day };
}

/** Filtra por rango de días inclusivo [start, end] (YYYY-MM-DD; vacío = sin límite). */
export function filterByDate(intervals: PrInterval[], start: string, end: string): PrInterval[] {
    return intervals.filter((iv) => (!start || iv.day >= start) && (!end || iv.day <= end));
}

/** ¿Los intervalos son sub-horarios? Basta con que alguno caiga fuera de la hora
 *  en punto. Sirve para no ofrecer la agrupación por cuarto en plantas horarias,
 *  donde daría exactamente lo mismo que "hora". */
export function isSubHourly(intervals: PrInterval[]): boolean {
    return intervals.some((iv) => iv.minute !== 0);
}

/** Paso temporal más frecuente entre intervalos, en minutos (0 si no se puede
 *  deducir). Fija el `step` del selector de periodo: 15 en Fraga, 60 en una
 *  planta horaria, de modo que el picker salte justo de intervalo en intervalo. */
export function stepMinutes(intervals: PrInterval[]): number {
    const counts = new Map<number, number>();
    let best = 0;
    let bestN = 0;
    for (let i = 1; i < intervals.length; i++) {
        const d = Math.round((intervals[i].ms - intervals[i - 1].ms) / 60000);
        if (d <= 0) continue;
        const n = (counts.get(d) ?? 0) + 1;
        counts.set(d, n);
        if (n > bestN) { bestN = n; best = d; }
    }
    return best;
}

/** Reparte una fila HORARIA en el k-esimo sub-intervalo de su hora. */
function splitInterval(iv: PrInterval, k: number, step: number, n: number): PrInterval {
    const minute = k * step;
    const hh = String(iv.hour).padStart(2, "0");
    const mm = String(minute).padStart(2, "0");
    return {
        ...iv,
        ts: `${iv.day}T${hh}:${mm}:00`,
        minute,
        tsKey: `${iv.day}T${hh}:${mm}`,
        ms: iv.ms + k * step * 60000,
        // ENERGIA (kWh): es un acumulado del paso -> se reparte entre los n
        // sub-intervalos, de modo que el total del dia no cambia ni un kWh.
        eMedida: iv.eMedida / n,
        eGarantizada: iv.eGarantizada / n,
        eEsperada: iv.eEsperada / n,
        // IRRADIANCIA (W/m2): es una TASA, no un acumulado -> se repite tal cual
        // (llega por el spread). Dividirla seria justo el error que deja la POA
        // esperada 4x baja.
        crit: { ...iv.crit },
    };
}

/** Normaliza la rejilla temporal de una planta sub-horaria.
 *
 *  El pipeline escribe pr_results con la resolucion del run: 15 min si la planta
 *  esta configurada asi (aggregate_by_hour=False) y 1 h en el resto. Si por lo que
 *  sea se cuela alguna fila HORARIA en una planta cuartohoraria —un run viejo que
 *  sobrevivio al borrado de huerfanas, o un tramo donde PVsyst solo tenia horario—
 *  esa fila arrastra la energia de una hora entera: sumada junto a los cuartos
 *  inflaria el dia, y comparada con ellos no es la misma magnitud.
 *
 *  Aqui esa fila se abre en los n sub-intervalos que le faltan (ver splitInterval).
 *  Una planta horaria (paso dominante 60 min) se devuelve INTACTA: si todo el run
 *  es horario, es que el run fue horario, y no hay nada que inventar.
 */
export function normalizeResolution(intervals: PrInterval[]): PrInterval[] {
    const step = stepMinutes(intervals);
    if (!step || step >= 60 || 60 % step !== 0) return intervals;
    const n = 60 / step;

    // Una hora que ya tiene alguna marca sub-horaria esta completa: su fila de
    // :00 es un cuarto legitimo, no una fila horaria.
    const subHours = new Set<string>();
    for (const iv of intervals) if (iv.minute !== 0) subHours.add(`${iv.day}T${iv.hour}`);

    const out: PrInterval[] = [];
    let expanded = 0;
    for (let i = 0; i < intervals.length; i++) {
        const iv = intervals[i];
        // La ULTIMA fila no se reparte aunque este sola en su hora: ahi lo normal
        // es que sea el borde del periodo (el run corta a las 00:00 del dia
        // siguiente), no una fila horaria. Repartirla inventaria tres marcas que
        // el run todavia no ha calculado.
        const closedHour = i < intervals.length - 1;
        if (iv.minute !== 0 || !closedHour || subHours.has(`${iv.day}T${iv.hour}`)) {
            out.push(iv);
            continue;
        }
        expanded += 1;
        for (let k = 0; k < n; k++) out.push(splitInterval(iv, k, step, n));
    }
    if (!expanded) return intervals;
    console.warn(`[pr] ${expanded} intervalo(s) horario(s) repartidos en ${n} de ${step} min`);
    return out.sort((a, b) => a.ms - b.ms);
}

/** Nº de buckets que generaría una granularidad (para decidir si cabe). */
export function bucketCount(intervals: PrInterval[], gran: Gran): number {
    const keys = new Set<string>();
    for (const iv of intervals) {
        if (gran === "interval") keys.add(iv.ts);
        else if (gran === "hour") keys.add(iv.day + "T" + iv.hour);
        else if (gran === "day") keys.add(iv.day);
        else keys.add(weekStartFromDay(iv.day).key);
    }
    return keys.size;
}

/** Granularidad automática: la más fina cuyos buckets no superen maxBars.
 *  Si ni por semana cabe, devuelve 'week' (el gráfico permitirá scroll). */
export function pickGranularity(intervals: PrInterval[], maxBars = 800): Gran {
    if (isSubHourly(intervals) && bucketCount(intervals, "interval") <= maxBars) return "interval";
    if (bucketCount(intervals, "hour") <= maxBars) return "hour";
    if (bucketCount(intervals, "day") <= maxBars) return "day";
    return "week";
}

/** Agrega energía por bucket (hora/día/semana). */
export function bucketize(intervals: PrInterval[], gran: Gran): Bucket[] {
    const map = new Map<string, Bucket>();
    for (const iv of intervals) {
        let key: string, label: string;
        if (gran === "interval") {
            // Cada intervalo es su propio bucket: es la resolución nativa de
            // pr_results (cuartohoraria si PVsyst y el SCADA lo permiten).
            key = iv.ts;
            label = `${iv.day.slice(5)} ${iv.ts.slice(11, 16)}`;
        } else if (gran === "hour") {
            key = iv.day + "T" + iv.hour;
            label = `${iv.day.slice(5)} ${String(iv.hour).padStart(2, "0")}h`;
        } else if (gran === "day") {
            key = iv.day;
            label = iv.day.slice(5);
        } else {
            const w = weekStartFromDay(iv.day);
            key = w.key;
            label = w.label;
        }
        let b = map.get(key);
        if (!b) {
            b = { key, label, ms: iv.ms, eMedida: 0, eGarantizada: 0, eEsperada: 0, validCount: 0, deltaPct: 0 };
            map.set(key, b);
        }
        b.ms = Math.min(b.ms, iv.ms);
        // Solo intervalos VÁLIDOS (igual que summarizeIntervals). Incluir los
        // excluidos falseaba el delta: medida≈0 vs garantizada>0 → muy negativo.
        if (iv.valid) {
            b.eMedida += iv.eMedida;
            b.eGarantizada += iv.eGarantizada;
            b.eEsperada += iv.eEsperada;
            b.validCount += 1;
        }
    }
    const out = [...map.values()].sort((a, b) => a.ms - b.ms);
    for (const b of out) b.deltaPct = b.eGarantizada ? ((b.eMedida - b.eGarantizada) / b.eGarantizada) * 100 : 0;
    return out;
}

export interface HourPoint {
    hour: number;
    eMedida: number;
    eGarantizada: number;
    eEsperada: number;
    poaM: number;
    poaE: number;
    ghiM: number;
    ghiE: number;
}

/** Perfil horario promedio (0–23). Energía = media entre días de la suma horaria;
 *  POA/GHI = media de los intervalos válidos a esa hora. */
export function hourProfile(intervals: PrInterval[]): HourPoint[] {
    // energía: suma por (día,hora) y luego media entre días
    const perDayHour = new Map<string, { m: number; g: number; e: number }>();
    // irradiancia: acumulador por hora
    const irr = Array.from({ length: 24 }, () => ({ pm: 0, pe: 0, gm: 0, ge: 0, n: 0 }));
    for (const iv of intervals) {
        if (!iv.valid) continue;
        const k = iv.day + "T" + iv.hour;
        let e = perDayHour.get(k);
        if (!e) {
            e = { m: 0, g: 0, e: 0 };
            perDayHour.set(k, e);
        }
        e.m += iv.eMedida;
        e.g += iv.eGarantizada;
        e.e += iv.eEsperada;
        const a = irr[iv.hour];
        a.pm += iv.poaM;
        a.pe += iv.poaE;
        a.gm += iv.ghiM;
        a.ge += iv.ghiE;
        a.n += 1;
    }
    const energyByHour = Array.from({ length: 24 }, () => ({ m: 0, g: 0, e: 0, days: 0 }));
    for (const [k, v] of perDayHour) {
        const h = Number(k.slice(k.indexOf("T") + 1));
        const acc = energyByHour[h];
        acc.m += v.m;
        acc.g += v.g;
        acc.e += v.e;
        acc.days += 1;
    }
    return Array.from({ length: 24 }, (_, h) => {
        const e = energyByHour[h];
        const a = irr[h];
        return {
            hour: h,
            eMedida: e.days ? e.m / e.days : 0,
            eGarantizada: e.days ? e.g / e.days : 0,
            eEsperada: e.days ? e.e / e.days : 0,
            poaM: a.n ? a.pm / a.n : 0,
            poaE: a.n ? a.pe / a.n : 0,
            ghiM: a.n ? a.gm / a.n : 0,
            ghiE: a.n ? a.ge / a.n : 0,
        };
    });
}

/** Agrega intervalos a filas diarias (para la vista "Por días" de la tabla). */
export function toDayRows(intervals: PrInterval[]): PrDaily[] {
    const map = new Map<string, {
        m: number; g: number; e: number; pm: number; pe: number; gm: number; ge: number;
        vint: number; irrN: number;
    }>();
    for (const iv of intervals) {
        let d = map.get(iv.day);
        if (!d) {
            d = { m: 0, g: 0, e: 0, pm: 0, pe: 0, gm: 0, ge: 0, vint: 0, irrN: 0 };
            map.set(iv.day, d);
        }
        // Solo válidos (consistente con el resumen y las barras de producción).
        if (iv.valid) {
            d.m += iv.eMedida;
            d.g += iv.eGarantizada;
            d.e += iv.eEsperada;
            d.vint += 1;
            d.pm += iv.poaM;
            d.pe += iv.poaE;
            d.gm += iv.ghiM;
            d.ge += iv.ghiE;
            d.irrN += 1;
        }
    }
    return [...map.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, d]) => ({
            day,
            eMedida: d.m,
            eGarantizada: d.g,
            eEsperada: d.e,
            poaMedida: d.irrN ? d.pm / d.irrN : 0,
            poaEsperada: d.irrN ? d.pe / d.irrN : 0,
            ghiMedida: d.irrN ? d.gm / d.irrN : 0,
            ghiEsperada: d.irrN ? d.ge / d.irrN : 0,
            validDay: d.vint > 0,
            validIntervals: d.vint,
            deltaPct: d.g ? ((d.m - d.g) / d.g) * 100 : 0,
        }));
}

/** Conteo de días totales y válidos (para la auditoría). */
export function dayStats(intervals: PrInterval[]): { total: number; valid: number; pct: number } {
    const days = new Map<string, boolean>();
    for (const iv of intervals) {
        days.set(iv.day, (days.get(iv.day) || false) || iv.valid);
    }
    const total = days.size;
    let valid = 0;
    for (const v of days.values()) if (v) valid += 1;
    return { total, valid, pct: total ? (valid / total) * 100 : 0 };
}
