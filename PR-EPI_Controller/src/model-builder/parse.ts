//-----------------------------------------------------------------------
// File readers: SCADA / meter exports (xlsx or csv) and PVsyst results.
// Everything is read in the browser; nothing leaves the user's machine.
// Times are converted to integer minutes since the Excel epoch (1899-12-30)
// so that timestamps compare exactly (no floating-point drift).
//-----------------------------------------------------------------------

import type { PvsystTable, RawTable } from "./types";

export const MIN_PER_DAY = 1440;
const EXCEL_EPOCH_UNIX_DAYS = 25569; // 1970-01-01 as Excel serial

export function dateToMin(d: Date): number {
    return Math.round((d.getTime() / 86400000 + EXCEL_EPOCH_UNIX_DAYS) * MIN_PER_DAY);
}
export function minToSerial(m: number): number {
    return m / MIN_PER_DAY;
}
export function minToDate(m: number): Date {
    // Whole minutes → exact milliseconds (dividing by 1440 first loses a minute to rounding)
    return new Date(Math.round(m - EXCEL_EPOCH_UNIX_DAYS * MIN_PER_DAY) * 60000);
}
/** yyyy-mm-dd (UTC parts, which is how the Excel serial is interpreted). */
export function minToIso(m: number): string {
    return minToDate(m).toISOString().slice(0, 10);
}
export function minToIsoTime(m: number): string {
    return minToDate(m).toISOString().slice(0, 16).replace("T", " ");
}
/** yyyy-mm-ddTHH:MM (or yyyy-mm-dd) → minutes since the Excel epoch; null if malformed. */
export function isoDateTimeToMin(s: string): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(s.trim());
    if (!m) return null;
    return dateToMin(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0))));
}
export function isoToMin(iso: string): number {
    const [y, mo, d] = iso.split("-").map(Number);
    return dateToMin(new Date(Date.UTC(y, mo - 1, d)));
}

// ── Text parsing ───────────────────────────────────────────────────────
export type DateOrder = "DMY" | "MDY" | "YMD";
const DATE_RE = /^\s*(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?\s*$/;

export function parseDateText(s: string, order: DateOrder): number | null {
    const m = DATE_RE.exec(s);
    if (!m) return null;
    const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]);
    let y: number, mo: number, d: number;
    if (m[1].length === 4) { y = a; mo = b; d = c; }
    else if (order === "MDY") { mo = a; d = b; y = c; }
    else { d = a; mo = b; y = c; }
    if (y < 100) y += 2000;
    const h = Number(m[4] ?? 0), mi = Number(m[5] ?? 0), sec = Number(m[6] ?? 0);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return dateToMin(new Date(Date.UTC(y, mo - 1, d, h, mi, Math.round(sec))));
}

/** Decide DMY vs MDY from a sample of date strings. */
export function detectDateOrder(samples: string[], fallback: DateOrder): DateOrder {
    let dmy = false, mdy = false;
    for (const s of samples) {
        const m = DATE_RE.exec(s);
        if (!m || m[1].length === 4) continue;
        if (Number(m[1]) > 12) dmy = true;
        if (Number(m[2]) > 12) mdy = true;
    }
    if (dmy && !mdy) return "DMY";
    if (mdy && !dmy) return "MDY";
    return fallback;
}

export function parseNum(s: string, decimalComma: boolean): number | string | null {
    const t = s.trim();
    if (t === "") return null;
    const norm = decimalComma ? t.replace(/\./g, "").replace(",", ".") : t;
    const n = Number(norm);
    return Number.isFinite(n) ? n : t;
}

export function decodeText(buf: ArrayBuffer): string {
    const utf = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const text = utf.includes("\uFFFD") ? new TextDecoder("windows-1252").decode(buf) : utf;
    return text.replace(/^\uFEFF/, "");
}

function splitLine(line: string, delim: string): string[] {
    if (!line.includes('"')) return line.split(delim);
    const out: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (q && line[i + 1] === '"') { cur += '"'; i++; }
            else q = !q;
        } else if (ch === delim && !q) { out.push(cur); cur = ""; }
        else cur += ch;
    }
    out.push(cur);
    return out;
}

const DATE_HEADER = /^(date|fecha|timestamp|time|datetime|fecha y hora|fecha\/hora|date\/time|date time|fecha hora|hora|tiempo|time ?stamp|local time|hora local)$/i;
const MIN_1990 = 32874 * MIN_PER_DAY, MIN_2100 = 73051 * MIN_PER_DAY;

/**
 * Convert one cell of the date column to minutes since the Excel epoch.
 * Cells read from Excel as dates are already minutes (> 1e6); plain numbers
 * between 1990 and 2100 are Excel serials; text is parsed with the order.
 */
export function cellToMin(v: unknown, order: DateOrder = "DMY"): number | null {
    if (typeof v === "number") {
        if (v >= MIN_1990 && v <= MIN_2100) return Math.round(v);
        if (v >= 32874 && v <= 73051) return Math.round(v * MIN_PER_DAY);
        return null;
    }
    if (typeof v === "string") {
        const m = parseDateText(v, order);
        return m !== null && m >= MIN_1990 && m <= MIN_2100 ? m : null;
    }
    return null;
}

/** Timestamps of a table (null where the date cell is not a date). */
export function rowTimes(raw: RawTable, col = raw.dateCol): (number | null)[] {
    const order = raw.dateOrder ?? "DMY";
    return raw.rows.map((r) => (col >= 0 ? cellToMin(r[col], order) : null));
}

/**
 * Pick the date column by content, not by position: the column with most
 * cells that read as a date between 1990 and 2100. An index column (1, 2, 3…)
 * or a time-only column never wins. The header name breaks ties.
 */
export function detectDateColumn(headers: string[], rows: unknown[][], order: DateOrder): number {
    const sample = rows.length > 600 ? rows.filter((_, i) => i % Math.ceil(rows.length / 600) === 0) : rows;
    let best = -1, bestScore = 0;
    headers.forEach((h, j) => {
        const times = sample.map((r) => cellToMin(r[j], order)).filter((x): x is number => x !== null);
        if (!times.length) return;
        // A real timestamp column has distinct values and some time of day
        const distinct = new Set(times).size;
        let score = times.length + distinct / 1e3;
        if (DATE_HEADER.test(h.trim())) score += 0.5;
        if (score > bestScore) { bestScore = score; best = j; }
    });
    return best;
}

/** True when a would-be header row actually holds data (headerless export). */
function looksLikeData(cells: unknown[]): boolean {
    return cells.some((v) => v instanceof Date || (typeof v === "string" && DATE_RE.test(v)) || (typeof v === "number" && v >= 32874 && v <= 73051));
}
const colName = (i: number) => { let s = "", n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return `Column ${s}`; };

/** Generic CSV table: header row = first line (unless it already holds data), date column detected by content. */
export function parseCsvTable(text: string, fileName: string): RawTable {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length < 1) throw new Error(`${fileName}: the file has no data rows.`);
    const head = lines[0];
    const delim = [";", "\t", ","].map((d) => [d, head.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
    const first = splitLine(head, delim).map((h) => h.trim());
    const headerless = looksLikeData(first);
    const headers = headerless ? first.map((_, i) => colName(i)) : first;
    const body = (headerless ? lines : lines.slice(1)).map((l) => splitLine(l, delim));
    if (!body.length) throw new Error(`${fileName}: the file has no data rows.`);
    const textCells = body.slice(0, 500).flat().filter((v) => DATE_RE.test(v));
    const order = detectDateOrder(textCells, delim === "," ? "MDY" : "DMY");
    // Decimal comma: semicolon files with values like 12,5
    const decimalComma = delim !== "," && body.slice(0, 50).some((r) => r.some((v) => /^-?\d+,\d+$/.test(v.trim())));
    const rows = body.map((r) => headers.map((_, i) => {
        const s = (r[i] ?? "").trim();
        if (DATE_RE.test(s)) return s; // keep dates as text; read with rowTimes()
        return parseNum(s, decimalComma);
    }));
    const dateCol = detectDateColumn(headers, rows, order);
    return { fileNames: [fileName], headers, rows, dateCol, dateOrder: order };
}

type ExcelCell = unknown;
function normCell(v: ExcelCell): number | string | null | Date {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v;
    if (typeof v === "number") return v;
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "object") {
        const o = v as Record<string, unknown>;
        if ("result" in o) return normCell(o.result);
        if ("richText" in o && Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((x) => x.text).join("");
        if ("text" in o) return String(o.text);
        if ("error" in o) return null;
    }
    return String(v);
}

/** First worksheet of an xlsx file. Header = first row with at least two filled cells (unless it holds data). */
export async function parseXlsxTable(buf: ArrayBuffer, fileName: string): Promise<RawTable> {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error(`${fileName}: no worksheet found.`);
    const grid: (number | string | null | Date)[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
        const vals = (row.values as ExcelCell[]).slice(1).map(normCell);
        grid.push(vals);
    });
    const hi = grid.findIndex((r) => r.filter((v) => v !== null && v !== "").length >= 2);
    if (hi < 0) throw new Error(`${fileName}: could not find a header row.`);
    const headerless = looksLikeData(grid[hi]);
    const width = Math.max(...grid.slice(hi, hi + 50).map((r) => r.length));
    const rawHeaders = headerless
        ? Array.from({ length: width }, (_, i) => colName(i))
        : grid[hi].map((v) => (v === null ? "" : v instanceof Date ? v.toISOString() : String(v).trim()));
    // Drop columns without a header (e.g. the empty first column of some meter exports)
    const keep = rawHeaders.map((h, i) => (h !== "" ? i : -1)).filter((i) => i >= 0);
    const headers = keep.map((i) => rawHeaders[i]);
    const body = grid.slice(headerless ? hi : hi + 1).filter((r) => r.some((v) => v !== null && v !== ""));
    const textCells = body.slice(0, 500).flatMap((r) => keep.map((ci) => r[ci])).filter((v): v is string => typeof v === "string" && DATE_RE.test(v));
    const order = detectDateOrder(textCells, "DMY");
    const rows = body.map((r) => keep.map((ci) => {
        const v = r[ci] ?? null;
        if (v instanceof Date) return dateToMin(v);
        if (typeof v === "string") { const s = v.trim(); return DATE_RE.test(s) ? s : parseNum(s, /^-?\d+,\d+$/.test(s)); }
        return v;
    }));
    const dateCol = detectDateColumn(headers, rows, order);
    return { fileNames: [fileName], headers, rows, dateCol, dateOrder: order };
}

export async function readTableFile(file: File): Promise<RawTable> {
    const buf = await file.arrayBuffer();
    return readTableBuffer(buf, file.name);
}

export async function readTableBuffer(buf: ArrayBuffer, fileName: string): Promise<RawTable> {
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return parseXlsxTable(buf, fileName);
    if (lower.endsWith(".csv") || lower.endsWith(".txt")) return parseCsvTable(decodeText(buf), fileName);
    throw new Error(`${fileName}: use .xlsx, .xlsm or .csv files (old .xls is not supported; save it as .xlsx).`);
}

/** Stack several exports of the same system (Power Query "Folder" import). Columns are matched by name. */
export function stackTables(tables: RawTable[]): RawTable {
    if (tables.length === 1) return tables[0];
    const headers: string[] = [];
    for (const t of tables) for (const h of t.headers) if (!headers.includes(h)) headers.push(h);
    const dateName = tables[0].headers[tables[0].dateCol];
    const rows: RawTable["rows"] = [];
    for (const t of tables) {
        const idx = headers.map((h) => (h === dateName ? t.dateCol : t.headers.indexOf(h)));
        for (const r of t.rows) rows.push(idx.map((i) => (i >= 0 ? r[i] ?? null : null)));
    }
    return { fileNames: tables.flatMap((t) => t.fileNames), headers, rows, dateCol: headers.indexOf(dateName), dateOrder: tables[0].dateOrder };
}

// ── PVsyst HourlyRes CSV ───────────────────────────────────────────────
/**
 * PVsyst "Hourly results" export: a block of project lines, then a header line
 * starting with "date", a units line and the data. Semicolon separated,
 * usually Windows-1252 and decimal comma, dates as dd/mm/yy HH:MM.
 */
export function parsePvsystCsv(text: string, fileName: string): PvsystTable {
    const lines = text.split(/\r?\n/);
    const hi = lines.findIndex((l) => /^\s*date\s*;/i.test(l));
    if (hi < 0) throw new Error(`${fileName}: this does not look like a PVsyst hourly results file (no "date" header line).`);
    const headers = lines[hi].split(";").map((h) => h.trim());
    const units = (lines[hi + 1] ?? "").split(";").map((u) => u.trim());
    const data = lines.slice(hi + 2).filter((l) => l.trim() !== "" && /\d/.test(l.split(";")[0]));
    const decimalComma = data.slice(0, 50).some((l) => /;-?\d+,\d+/.test(l));
    const order = detectDateOrder(data.slice(0, 200).map((l) => l.split(";")[0]), "DMY");
    const t: number[] = [];
    const cols: Record<string, (number | null)[]> = {};
    headers.slice(1).forEach((h) => (cols[h] = []));
    for (const l of data) {
        const parts = l.split(";");
        const m = parseDateText(parts[0], order);
        if (m === null) continue;
        t.push(m);
        headers.slice(1).forEach((h, i) => {
            const v = parseNum(parts[i + 1] ?? "", decimalComma);
            cols[h].push(typeof v === "number" ? v : null);
        });
    }
    if (!t.length) throw new Error(`${fileName}: no data rows found.`);
    if (!("E_Grid" in cols)) throw new Error(`${fileName}: the file has no E_Grid column. Add E_Grid to the PVsyst hourly output.`);
    const stepMin = t.length > 1 ? t[1] - t[0] : 60;
    void units;
    return { fileName, t, cols, headers: headers.slice(1), stepMin };
}

export async function readPvsystFile(file: File): Promise<PvsystTable> {
    return parsePvsystCsv(decodeText(await file.arrayBuffer()), file.name);
}
