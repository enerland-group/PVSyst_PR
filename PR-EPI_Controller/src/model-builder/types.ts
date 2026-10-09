//-----------------------------------------------------------------------
// Model builder — shared types.
// A "model" is the full configuration of a performance test (PR or EPI).
// The engine turns config + imported data into computed columns, and the
// workbook writer turns the same column plan into live Excel formulas.
//-----------------------------------------------------------------------

export type TestType = "EPI" | "PR";

export type ParamId =
    | "GHI" | "POA" | "REF" | "DHI" | "T_AMB" | "T_MOD"
    | "WS" | "WA" | "E_GRID" | "E_IMP" | "SETPOINT" | "PF";

/** A cell value as Excel would hold it: number, text ("Outlier", "Discard", "") or empty. */
export type Val = number | string | null;

/** Imported, cleaned table. Time is stored as integer minutes since 1899-12-30 (Excel epoch). */
export interface Dataset {
    t: number[];
    cols: Record<string, (number | null)[]>;
    flags: string[];
    stepMin: number;
    /** 1 when at least one meteo value of the row was interpolated. */
    interp: number[];
}

export interface RawTable {
    fileNames: string[];
    headers: string[];
    /** Rows of raw values. Excel dates are minutes since the Excel epoch; text dates stay text (read them with rowTimes). */
    rows: (number | string | null)[][];
    /** Date column detected by content (-1 = none found). */
    dateCol: number;
    /** Day/month order of text dates. */
    dateOrder?: "DMY" | "MDY" | "YMD";
}

export interface SensorMapping {
    raw: string;
    param: ParamId | "DATE" | null;
}

export type FilterMethod = "IQR" | "DAILY_MEAN" | "NONE";

export interface Round {
    pct: number; // fraction, 0.05 = 5 %
    abs: number;
}

export interface ParamFilter {
    method: FilterMethod;
    /** Daily-mean method: tolerance (fraction) and whether the test is two-sided. */
    dailyTol: number;
    dailyTwoSided: boolean;
    rounds: Round[];
}

export type CriterionType =
    | "available"      // final column of a parameter has a value
    | "poaFloor"       // POA ≥ POA_Floor
    | "seasonalHours"  // hours per day above a seasonal POA threshold
    | "aggHours"       // minimum aggregated valid hours over the whole test
    | "curtailment"    // setpoint ≥ POI, no wind alarm, PF within range
    | "noMissing"      // no blank raw values for the listed parameters (PR)
    | "exporting"      // meter power > 0 (PR)
    | "setpointMin"    // setpoint ≥ Setpoint_Min (PR)
    | "manual"         // editable 1/0 column
    | "threshold";     // any parameter compared with a value (e.g. GHI > 10, POA > 0)

export interface Criterion {
    id: string;
    type: CriterionType;
    on: boolean;
    label: string;
    /** For "available" (may include "ALB") and "noMissing". */
    params?: (ParamId | "ALB")[];
    /** "threshold": parameter, operator and value. */
    param?: ParamId | "ALB";
    op?: ">=" | ">";
    value?: number;
    /** "aggHours": count only intervals above the seasonal POA threshold (Terrer criterion 5). */
    aboveSeasonal?: boolean;
    /** "manual" (EPI): instead of excluding, replace the measured energy of flagged intervals by the expected energy (Horus III criterion 4). */
    replaceWithExpected?: boolean;
    /** "exporting": the whole day fails if any active interval (POA ≥ floor) has no injection (Ensol criterion 3: 100 % availability). */
    dayLevel?: boolean;
    /** Curtailment options. */
    windAlarm?: boolean;
    pf?: boolean;
    /** noMissing: treat the interval as valid when the POA floor already fails (night). */
    exceptWhenFloorFails?: boolean;
}

export interface QcConfig {
    irrMin: number;
    irrMax: number;
    tMin: number;
    tMax: number;
    deadAbrupt: boolean;
    deadDeriv: number;   // per second
    deadMinValue: number;
    abruptIrr: number;   // W/m² per second
    abruptT: number;     // °C per second
    /** Fill gaps of up to N consecutive missing values by linear interpolation (0 = off). */
    interpMaxGap: number;
}

/** Valid days and test period (shared by PR and EPI). */
/** A period excluded by hand. Times are local plant time, yyyy-mm-ddTHH:MM; an interval counts as excluded when its end-of-interval stamp t satisfies from < t ≤ to. */
export interface Exclusion {
    from: string;
    to: string;
    cause: string;
    reason: string;
    evidence: string;
}

export interface DaysConfig {
    /** Valid days the test needs (0 = no requirement). */
    required: number;
    /** Maximum calendar days from the first test day (0 = no limit). Days after it are not used. */
    maxWindow: number;
    /** If the window ends without enough valid days, use the K days with the highest irradiation (0 = off). */
    fallbackTopK: number;
    /** Hours of valid intervals with POA ≥ hoursPoaThr needed in a day (0 = off). */
    minHours: number;
    hoursPoaThr: number;
    /** Minimum daily POA irradiation, Wh/m² (0 = off). */
    minDailyWh: number;
    /** Daily irradiation over all intervals of the day (true) or valid ones only. */
    irrAllIntervals: boolean;
    /** Maximum share of interpolated intervals among the valid intervals of a day (only with interpolation). */
    maxInterpPct: number;
    /** Periods excluded by hand (events not attributable to the contractor). */
    excluded: Exclusion[];
}

export type MeterMode = "two" | "net" | "prod";
export type MeterUnit = "power" | "energy" | "counter";

export interface MeterConfig {
    source: "file" | "scada";
    mode: MeterMode;
    unit: MeterUnit;
    /** Column names in the meter file (source=file). For source=scada the E_GRID / E_IMP params are used. */
    dateCol: string;
    prodCol: string;
    consCol: string;
}

export interface EpiConfig {
    guaranteedEpi: number;
    degradation: number;
    availability: number;
    timeShiftMin: number;
    aggregateByHour: boolean;
    passRule: "energy" | "epi";
}

export interface PrConfig {
    pstcKwp: number;
    pstcNote: string;
    gstc: number;
    deltaPctPerC: number;      // e.g. -0.26 (%/°C)
    ft: number;                // tolerance factor
    tavg: number[];            // 12 monthly values, °C
    prDesign: number[];        // 12 monthly values, fraction
    overall: "mean" | "weighted";
    /** Albedo of the design model and allowed deviation (Ensol: 0.17 ± 20 % → otherwise recalculate PR_D). 0 = no check. */
    albedoBase: number;
    albedoTol: number;
}

export interface Thresholds {
    poaFloor: number;
    summerStart: number;
    summerEnd: number;
    poaThrSummer: number;
    poaThrWinter: number;
    minHoursDay: number;
    minHoursTest: number;
    poiKw: number;
    pfMin: number;
    pfMax: number;
    setpointMin: number;
}

export interface ProjectInfo {
    name: string;
    code: string;
    country: string;
    lang: "EN" | "ES";
    client: string;
    contractRef: string;
}

export interface ModelConfig {
    version: 1;
    type: TestType;
    /** Contract procedure the model started from, if any. */
    procedure?: string;
    project: ProjectInfo;
    periodStart: string; // yyyy-mm-dd, "" = all data
    periodEnd: string;
    mapping: SensorMapping[];
    filters: Partial<Record<ParamId, ParamFilter>>;
    iqrK: number;
    /** Albedo pairs, by workbook sensor name, e.g. { ref: "REF 01", glob: "GHI 01" }. */
    albedo: { ref: string; glob: string }[];
    qc: QcConfig;
    criteria: Criterion[];
    thr: Thresholds;
    days: DaysConfig;
    epi: EpiConfig;
    pr: PrConfig;
    meter: MeterConfig;
}

export interface PvsystTable {
    fileName: string;
    /** minutes since Excel epoch, as written in the file (before time shift) */
    t: number[];
    cols: Record<string, (number | null)[]>;
    headers: string[];
    stepMin: number;
}

export interface MeterTable {
    fileNames: string[];
    t: number[];
    prod: (number | null)[];
    cons: (number | null)[];
    headers: string[];
    stepMin: number;
}
