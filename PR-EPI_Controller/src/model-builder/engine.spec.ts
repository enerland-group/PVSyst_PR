//-----------------------------------------------------------------------
// Unit tests for the model-builder engine (synthetic data, no files).
// The full regression against the Fraga and Ensol workbooks lives outside
// the repo because it needs project data; see deploy.md.
//-----------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { buildPlan, quartileInc, colLetter } from "./engine";
import { buildDataset } from "./import";
import { defaultConfig } from "./presets";
import { suggestParam } from "./params";
import { parsePvsystCsv, parseDateText } from "./parse";
import type { RawTable } from "./types";

const T0 = Math.round((Date.UTC(2026, 4, 1) / 864e5 + 25569) * 1440); // 2026-05-01 00:00

function raw(): RawTable {
    const headers = ["Date", "POA 1", "POA 2", "POA 3", "POA 4", "Air temp", "PPC setpoint (kW)"];
    const rows = Array.from({ length: 96 }, (_, i) => {
        const t = T0 + 15 * (i + 1);
        const g = Math.max(0, 1000 * Math.sin(((i - 24) / 48) * Math.PI));
        return [t, g, g * 1.01, i === 50 ? g * 2 : g * 0.99, g * 1.02, 20, 5000];
    });
    return { fileNames: ["x.xlsx"], headers, rows, dateCol: 0 };
}

describe("model-builder engine", () => {
    it("matches Excel QUARTILE.INC", () => {
        expect(quartileInc([1, 2, 3, 4], 1)).toBeCloseTo(1.75);
        expect(quartileInc([1, 2, 3, 4], 3)).toBeCloseTo(3.25);
    });
    it("builds column letters", () => {
        expect(colLetter(0)).toBe("A");
        expect(colLetter(25)).toBe("Z");
        expect(colLetter(26)).toBe("AA");
    });
    it("suggests parameters from SCADA names", () => {
        expect(suggestParam("Weather Station CT1 - R2-D - POA SOLAR IRRADIANCE 1 () (W/m2)")).toBe("POA");
        expect(suggestParam("PPC GPM - ACTIVE POWER SETPOINT (kW)")).toBe("SETPOINT");
        expect(suggestParam("Meter PPC - FACTOR DE POTENCIA")).toBe("PF");
    });
    it("parses PVsyst and SCADA dates", () => {
        expect(parseDateText("21/04/26 10:00", "DMY")).toBe(T0 - 10 * 1440 + 600);
        const pv = parsePvsystCsv("PVSYST\r\n\r\ndate;GlobEff;E_Grid\r\n ;W/m²;kW\r\n\r\n01/05/26 10:00;800,5;1000\r\n01/05/26 11:00;900;1100,25\r\n", "x.csv");
        expect(pv.t.length).toBe(2);
        expect(pv.cols.E_Grid[1]).toBeCloseTo(1100.25);
        expect(pv.stepMin).toBe(60);
    });
    it("flags the outlier sensor and applies criteria", () => {
        const cfg = defaultConfig("EPI");
        cfg.mapping = [
            { raw: "Date", param: "DATE" }, { raw: "POA 1", param: "POA" }, { raw: "POA 2", param: "POA" },
            { raw: "POA 3", param: "POA" }, { raw: "POA 4", param: "POA" }, { raw: "Air temp", param: "T_AMB" }, { raw: "PPC setpoint (kW)", param: "SETPOINT" },
        ];
        cfg.criteria = cfg.criteria.map((c) => ({ ...c, on: c.type === "poaFloor" || c.type === "curtailment", windAlarm: false, pf: false }));
        cfg.thr.poiKw = 4000;
        const { ds, stats } = buildDataset(raw(), cfg);
        expect(stats.rows).toBe(96);
        const plan = buildPlan(cfg, ds);
        expect(plan.sheet.get("POA 03 Filtered").values[50]).toBe("Outlier");
        const comply = plan.sheet.get(plan.comply).values as number[];
        const poa = plan.sheet.get("POA_Average Filtered").values as number[];
        comply.forEach((c, i) => expect(c).toBe(poa[i] >= 100 ? 1 : 0));
        expect(plan.sheet.get(plan.comply).f!(2)).toMatch(/^[A-Z]+2\*[A-Z]+2\*[A-Z]+2$/); // two criteria + excluded periods
    });
});
