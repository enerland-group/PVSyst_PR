import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseCsvTable, parseXlsxTable, rowTimes, minToIsoTime, stackTables } from "./parse";
import { suggestMapping } from "./params";
import { suggestMeterColumns } from "./presets";

/** Export like the one that came out as 1899-12-30: index in column A, text dates in B. */
async function xlsx(header: string[] | null, day: number): Promise<ArrayBuffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Data");
    if (header) ws.addRow(header);
    for (let k = 1; k <= 96; k++) {
        const h = Math.floor((k * 15) / 60) % 24, m = (k * 15) % 60;
        const d = k === 96 ? day + 1 : day;
        ws.addRow([k, `${String(d).padStart(2, "0")}-07-2026 ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, 0, k > 30 && k < 80 ? 9000 + k : 0]);
    }
    return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

describe("date column detection", () => {
    it("ignores an index column in A and reads DD-MM-YYYY text dates", async () => {
        const t = await parseXlsxTable(await xlsx(["Nº", "Fecha", "Importada (kW)", "Exportada (kW)"], 26), "a.xlsx");
        expect(t.headers[t.dateCol]).toBe("Fecha");
        const times = rowTimes(t);
        expect(minToIsoTime(times[0]!)).toBe("2026-07-26 00:15");
        expect(minToIsoTime(times[95]!)).toBe("2026-07-27 00:00");
        const map = suggestMapping(t.headers, undefined, t.dateCol);
        expect(map.find((m) => m.param === "DATE")?.raw).toBe("Fecha");
        expect(map[0].param).toBeNull();
    });

    it("works when the date header is not a known word", async () => {
        const t = await parseXlsxTable(await xlsx(["Nº", "Periodo", "C", "D"], 26), "a.xlsx");
        expect(t.headers[t.dateCol]).toBe("Periodo");
    });

    it("handles exports without a header row", async () => {
        const t = await parseXlsxTable(await xlsx(null, 26), "a.xlsx");
        expect(t.headers).toEqual(["Column A", "Column B", "Column C", "Column D"]);
        expect(t.rows.length).toBe(96);
        expect(t.headers[t.dateCol]).toBe("Column B");
    });

    it("stacks 17 daily files into 17 days, not 96 minutes", async () => {
        const tables = [];
        for (let d = 10; d < 27; d++) tables.push(await parseXlsxTable(await xlsx(["Nº", "Fecha", "Imp", "Exp"], d), `${d}.xlsx`));
        const all = stackTables(tables);
        const times = rowTimes(all).filter((x): x is number => x !== null);
        expect(new Set(times).size).toBe(17 * 96);
    });

    it("meter: production is the column with energy, not the zero or index column", async () => {
        const t = await parseXlsxTable(await xlsx(["Nº", "Fecha", "C", "D"], 26), "m.xlsx");
        const s = suggestMeterColumns(t);
        expect(s.date).toBe("Fecha");
        expect(s.prod).toBe("D");
    });

    it("csv with an index column", () => {
        const csv = "Id;Fecha;P\n1;26/07/2026 00:15;0\n2;26/07/2026 00:30;0\n3;26/07/2026 00:45;1,5";
        const t = parseCsvTable(csv, "x.csv");
        expect(t.headers[t.dateCol]).toBe("Fecha");
        expect(minToIsoTime(rowTimes(t)[2]!)).toBe("2026-07-26 00:45");
        expect(t.rows[2][2]).toBe(1.5);
    });
});
