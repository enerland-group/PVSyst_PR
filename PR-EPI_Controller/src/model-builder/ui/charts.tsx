//-----------------------------------------------------------------------
// Light SVG charts for the wizard: time series with a zoom slider,
// daily bars, scatter and a completeness map. No chart library: the data
// is already in memory and a few thousand points per series is plenty.
//-----------------------------------------------------------------------

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { minToDate } from "../parse";

export interface Series { name: string; color: string; values: (number | null | string)[]; dash?: string; width?: number; opacity?: number }
export type Range = [number, number];

export const PALETTE = ["#0f6cbd", "#e8740c", "#2a9d8f", "#8a4fbf", "#c2407a", "#6b8e23", "#8c6d1f", "#4f6d8a"];
const AXIS = "var(--color-muted-foreground)";
const GRID = "color-mix(in srgb, var(--color-border) 70%, transparent)";
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const fmtN = (v: number, d = 0) => v.toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d });
const dd = (m: number) => { const d = minToDate(m); return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
const hm = (m: number) => { const d = minToDate(m); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };

function niceTicks(lo: number, hi: number, n = 4): number[] {
    const span = hi - lo || 1;
    const step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n + 0.5) ?? mag * 10;
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
}

/** Time ticks: days when the span is long, hours otherwise. */
function timeTicks(a: number, b: number): { at: number; label: string; major: boolean }[] {
    const span = b - a;
    if (span > 2.5 * 1440) {
        const every = Math.max(1, Math.ceil(span / 1440 / 12));
        const out = [];
        for (let d = Math.ceil(a / 1440); d * 1440 <= b; d += every) out.push({ at: d * 1440, label: dd(d * 1440), major: true });
        return out;
    }
    const stepH = span > 1440 ? 6 : span > 720 ? 3 : span > 240 ? 1 : 0.5;
    const out = [];
    for (let m = Math.ceil(a / (stepH * 60)) * stepH * 60; m <= b; m += stepH * 60) {
        const midnight = m % 1440 === 0;
        out.push({ at: m, label: midnight ? dd(m) : hm(m), major: midnight });
    }
    return out;
}

/** Downsample to at most ~2 points per pixel keeping min and max (spikes stay visible). */
function path(t: number[], v: (number | null | string)[], x: (m: number) => number, y: (n: number) => number, a: number, b: number, px: number): string {
    let i0 = 0;
    while (i0 < t.length && t[i0] < a) i0++;
    i0 = Math.max(0, i0 - 1);
    let i1 = i0;
    while (i1 < t.length && t[i1] <= b) i1++;
    i1 = Math.min(t.length, i1 + 1);
    const n = i1 - i0;
    let d = "", pen = false;
    const step = Math.max(1, n > 0 ? t[Math.min(t.length - 1, i0 + 1)] - t[i0] : 1);
    if (n <= px * 2) {
        for (let i = i0; i < i1; i++) {
            const val = num(v[i]);
            if (val === null || (i > i0 && t[i] - t[i - 1] > step * 1.5)) { pen = false; if (val === null) continue; }
            d += `${pen ? "L" : "M"}${x(t[i]).toFixed(1)} ${y(val).toFixed(1)}`;
            pen = true;
        }
        return d;
    }
    const per = n / px;
    for (let k = 0; k < px; k++) {
        const s = i0 + Math.floor(k * per), e = Math.min(i1, i0 + Math.floor((k + 1) * per));
        let lo = Infinity, hi = -Infinity, any = false;
        for (let i = s; i < e; i++) { const val = num(v[i]); if (val === null) continue; any = true; if (val < lo) lo = val; if (val > hi) hi = val; }
        if (!any) { pen = false; continue; }
        const xx = x(t[s]).toFixed(1);
        d += `${pen ? "L" : "M"}${xx} ${y(lo).toFixed(1)}L${xx} ${y(hi).toFixed(1)}`;
        pen = true;
    }
    return d;
}

/** Width of the container in CSS pixels, so the SVG is drawn 1:1 and the text keeps its size. */
function useWidth(initial = 800): [React.RefObject<HTMLDivElement | null>, number] {
    const ref = useRef<HTMLDivElement>(null);
    const [w, setW] = useState(initial);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const ro = new ResizeObserver((e) => { const cw = Math.round(e[0].contentRect.width); if (cw > 0) setW(cw); });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return [ref, w];
}

function Legend({ series, extra }: { series: Series[]; extra?: ReactNode }) {
    return (
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-100 text-muted-foreground">
            {series.map((s) => (
                <span key={s.name} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    <svg width="16" height="6" aria-hidden><line x1="0" x2="16" y1="3" y2="3" stroke={s.color} strokeWidth="2.5" strokeDasharray={s.dash} /></svg>{s.name}
                </span>
            ))}
            {extra}
        </div>
    );
}

export function ChartCard({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
    return (
        <div className="border border-border rounded-sm bg-card px-3 pt-2.5 pb-2 mb-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-1.5">
                <b className="text-200">{title}</b>
                <div className="ml-auto">{right}</div>
            </div>
            {children}
        </div>
    );
}

/**
 * Time series chart. `range` is the visible window (minutes); pass the same
 * range and onRange to several charts to zoom them together.
 */
export function TimeChart({ t, series, unit, height = 220, range, onRange, yMin, yMax, decimals = 0, bands, nav = true }: {
    t: number[]; series: Series[]; unit: string; height?: number; range: Range; onRange: (r: Range) => void;
    yMin?: number; yMax?: number; decimals?: number; bands?: { from: number; to: number; color: string }[]; nav?: boolean;
}) {
    const [box, W] = useWidth();
    const L = 52, R = 12, T = 20, B = 22;
    const [a, b] = range;
    const [hover, setHover] = useState<number | null>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    const clip = `clip${useId().replace(/:/g, "")}`;
    const vis = useMemo(() => {
        let lo = Infinity, hi = -Infinity;
        for (const s of series) for (let i = 0; i < t.length; i++) {
            if (t[i] < a || t[i] > b) continue;
            const v = num(s.values[i]); if (v === null) continue;
            if (v < lo) lo = v; if (v > hi) hi = v;
        }
        if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
        if (hi === lo) hi = lo + 1;
        const pad = (hi - lo) * 0.05;
        return { lo: yMin ?? (lo >= 0 && lo < (hi - lo) * 0.3 ? 0 : lo - pad), hi: yMax ?? hi + pad };
    }, [series, t, a, b, yMin, yMax]);
    const x = (m: number) => L + ((m - a) / (b - a || 1)) * (W - L - R);
    const y = (v: number) => T + (1 - (v - vis.lo) / (vis.hi - vis.lo)) * (height - T - B);
    const ticks = niceTicks(vis.lo, vis.hi);
    const tt = timeTicks(a, b);
    const onMove = (e: React.PointerEvent) => {
        const r = svgRef.current!.getBoundingClientRect();
        const m = a + ((((e.clientX - r.left) / r.width) * W - L) / (W - L - R)) * (b - a);
        if (m < a || m > b) { setHover(null); return; }
        // nearest timestamp
        let lo = 0, hi = t.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] < m) lo = mid; else hi = mid; }
        setHover(Math.abs(t[lo] - m) < Math.abs(t[hi] - m) ? lo : hi);
    };
    return (
        <div ref={box}>
            <Legend series={series} />
            <div className="relative">
                <svg ref={svgRef} viewBox={`0 0 ${W} ${height}`} className="w-full h-auto block select-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={`Chart: ${series.map((s) => s.name).join(", ")}`}>
                    {bands?.map((bd, k) => bd.to >= a && bd.from <= b && <rect key={k} x={x(Math.max(a, bd.from))} y={T} width={Math.max(1.5, x(Math.min(b, bd.to)) - x(Math.max(a, bd.from)))} height={height - T - B} fill={bd.color} />)}
                    {ticks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={GRID} /><text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill={AXIS}>{fmtN(v, decimals)}</text></g>)}
                    {tt.map((k) => <g key={k.at}><line x1={x(k.at)} x2={x(k.at)} y1={T} y2={height - B} stroke={k.major ? GRID : "transparent"} /><text x={x(k.at)} y={height - 6} textAnchor="middle" fontSize="11" fill={AXIS}>{k.label}</text></g>)}
                    <text x={L - 6} y={11} textAnchor="end" fontSize="11" fill={AXIS}>{unit}</text>
                    <clipPath id={clip}><rect x={L} y={T} width={W - L - R} height={height - T - B} /></clipPath>
                    <g clipPath={`url(#${clip})`}>
                        {series.map((s) => <path key={s.name} d={path(t, s.values, x, y, a, b, W - L - R)} fill="none" stroke={s.color} strokeWidth={s.width ?? 1.4} strokeDasharray={s.dash} opacity={s.opacity ?? 1} strokeLinejoin="round" />)}
                    </g>
                    {hover !== null && <line x1={x(t[hover])} x2={x(t[hover])} y1={T} y2={height - B} stroke={AXIS} strokeDasharray="3 3" />}
                </svg>
                {hover !== null && (
                    <div className="absolute top-1 pointer-events-none bg-popover border border-border rounded-sm shadow-md px-2.5 py-1.5 text-100 z-10"
                        style={{ left: `${(x(t[hover]) / W) * 100}%`, transform: x(t[hover]) > W * 0.6 ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>
                        <div className="font-mono mb-0.5">{dd(t[hover])} {hm(t[hover])}</div>
                        {series.map((s) => { const v = num(s.values[hover]); return <div key={s.name} className="flex gap-2 justify-between whitespace-nowrap"><span style={{ color: s.color }}>{s.name}</span><b className="tabular-nums">{v === null ? "—" : fmtN(v, decimals || (Math.abs(v) < 10 ? 2 : 0))}</b></div>; })}
                    </div>
                )}
            </div>
            {nav && <Navigator t={t} values={series[0]?.values ?? []} range={range} onRange={onRange} />}
        </div>
    );
}

/** Zoom slider: drag the window or its edges; drag on the empty track to draw a new window. */
export function Navigator({ t, values, range, onRange }: { t: number[]; values: (number | null | string)[]; range: Range; onRange: (r: Range) => void }) {
    const [box, W] = useWidth();
    const H = 40, L = 52, R = 12;
    const t0 = t[0] ?? 0, t1 = t[t.length - 1] ?? 1;
    const ref = useRef<SVGSVGElement>(null);
    const drag = useRef<{ mode: "move" | "a" | "b" | "new"; start: number; r: Range } | null>(null);
    const X = (m: number) => L + ((m - t0) / (t1 - t0 || 1)) * (W - L - R);
    const M = (clientX: number) => { const r = ref.current!.getBoundingClientRect(); const px = ((clientX - r.left) / r.width) * W; return t0 + ((px - L) / (W - L - R)) * (t1 - t0); };
    const minSpan = Math.min(t1 - t0, 120);
    const clamp = (r: Range): Range => {
        let [a, b] = r;
        if (b - a < minSpan) { if (drag.current?.mode === "a") a = b - minSpan; else b = a + minSpan; }
        if (a < t0) { b += t0 - a; a = t0; }
        if (b > t1) { a -= b - t1; b = t1; }
        return [Math.max(t0, a), Math.min(t1, b)];
    };
    const lo = Math.min(...values.map(num).filter((v): v is number => v !== null), 0);
    const hiV = Math.max(...values.map(num).filter((v): v is number => v !== null), 1);
    const y = (v: number) => 4 + (1 - (v - lo) / (hiV - lo || 1)) * (H - 8);
    const onDown = (e: React.PointerEvent, mode: "move" | "a" | "b" | "new") => {
        e.stopPropagation();
        (e.target as Element).setPointerCapture?.(e.pointerId);
        drag.current = { mode, start: M(e.clientX), r: range };
        if (mode === "new") onRange(clamp([drag.current.start, drag.current.start + minSpan]));
    };
    const onMove = (e: React.PointerEvent) => {
        const d = drag.current; if (!d) return;
        const m = M(e.clientX), dm = m - d.start;
        if (d.mode === "move") onRange(clamp([d.r[0] + dm, d.r[1] + dm]));
        else if (d.mode === "a") onRange(clamp([Math.min(m, d.r[1] - minSpan), d.r[1]]));
        else if (d.mode === "b") onRange(clamp([d.r[0], Math.max(m, d.r[0] + minSpan)]));
        else onRange(clamp([Math.min(d.start, m), Math.max(d.start, m)]));
    };
    const full = range[0] <= t0 && range[1] >= t1;
    const days = Math.round((range[1] - range[0]) / 1440 * 10) / 10;
    return (
        <div className="mt-1" ref={box}>
            <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block touch-none select-none cursor-crosshair" onPointerDown={(e) => onDown(e, "new")} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }}
                role="slider" aria-label="Zoom: visible period" aria-valuemin={t0} aria-valuemax={t1} aria-valuenow={range[0]} tabIndex={0}
                onKeyDown={(e) => { const s = (range[1] - range[0]) * 0.25; if (e.key === "ArrowLeft") onRange(clamp([range[0] - s, range[1] - s])); if (e.key === "ArrowRight") onRange(clamp([range[0] + s, range[1] + s])); }}>
                <rect x={L} y={0} width={W - L - R} height={H} fill="var(--color-secondary)" stroke="var(--color-border)" />
                <path d={path(t, values, X, y, t0, t1, W - L - R)} fill="none" stroke={AXIS} strokeWidth="1" opacity="0.55" />
                <rect x={L} y={0} width={Math.max(0, X(range[0]) - L)} height={H} fill="var(--color-background)" opacity="0.65" pointerEvents="none" />
                <rect x={X(range[1])} y={0} width={Math.max(0, W - R - X(range[1]))} height={H} fill="var(--color-background)" opacity="0.65" pointerEvents="none" />
                <rect x={X(range[0])} y={0.5} width={Math.max(2, X(range[1]) - X(range[0]))} height={H - 1} fill="color-mix(in srgb, var(--color-primary) 10%, transparent)" stroke="var(--color-primary)" strokeWidth="1.2" className="cursor-grab" onPointerDown={(e) => onDown(e, "move")} />
                {(["a", "b"] as const).map((h) => (
                    <g key={h} className="cursor-ew-resize" onPointerDown={(e) => onDown(e, h)}>
                        <rect x={X(h === "a" ? range[0] : range[1]) - 6} y={0} width={12} height={H} fill="transparent" />
                        <rect x={X(h === "a" ? range[0] : range[1]) - 3} y={H / 2 - 9} width={6} height={18} rx={2} fill="var(--color-primary)" />
                    </g>
                ))}
            </svg>
            <div className="flex items-center gap-3 text-100 text-muted-foreground mt-1">
                <span>Drag the blue window or its edges to zoom · {full ? "whole period" : `${days} day${days === 1 ? "" : "s"} shown`}</span>
                {!full && <button type="button" className="ml-auto underline" onClick={() => onRange([t0, t1])}>Show all</button>}
            </div>
        </div>
    );
}

/** Grouped bars per category, optional line series on top (same axis). */
export function BarChart({ cats, bars, lines, unit, height = 220, decimals = 0, refLine, notes }: {
    cats: string[]; bars: Series[]; lines?: Series[]; unit: string; height?: number; decimals?: number; refLine?: { value: number; label: string }; notes?: (string | null)[];
}) {
    const [box, W] = useWidth();
    const L = 56, R = 12, T = 20, B = 24;
    const all = [...bars, ...(lines ?? [])].flatMap((s) => s.values.map(num)).filter((v): v is number => v !== null);
    let lo = Math.min(0, ...all, refLine?.value ?? 0), hi = Math.max(0, ...all, refLine?.value ?? 0);
    if (hi === lo) hi = lo + 1;
    hi += (hi - lo) * 0.08; if (lo < 0) lo -= (hi - lo) * 0.05;
    const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (height - T - B);
    const gw = (W - L - R) / Math.max(1, cats.length);
    const bw = (gw * 0.7) / Math.max(1, bars.length);
    const [hover, setHover] = useState<number | null>(null);
    return (
        <div ref={box}>
            <Legend series={[...bars, ...(lines ?? [])]} />
            <div className="relative">
                <svg viewBox={`0 0 ${W} ${height}`} className="w-full h-auto block" onPointerLeave={() => setHover(null)} role="img" aria-label={`Bar chart: ${bars.map((s) => s.name).join(", ")}`}>
                    {niceTicks(lo, hi).map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={v === 0 ? AXIS : GRID} strokeOpacity={v === 0 ? 0.5 : 1} /><text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill={AXIS}>{fmtN(v, decimals)}</text></g>)}
                    <text x={L - 6} y={11} textAnchor="end" fontSize="11" fill={AXIS}>{unit}</text>
                    {cats.map((c, k) => (
                        <g key={c + k} onPointerEnter={() => setHover(k)}>
                            <rect x={L + gw * k} y={T} width={gw} height={height - T - B} fill={hover === k ? "var(--color-accent)" : "transparent"} />
                            {bars.map((s, j) => { const v = num(s.values[k]); return v === null ? null : <rect key={s.name} x={L + gw * k + gw * 0.15 + j * bw} y={Math.min(y(v), y(0))} width={Math.max(1, bw - 2)} height={Math.max(1, Math.abs(y(v) - y(0)))} fill={s.color} rx={1} />; })}
                            {notes?.[k] && gw > 48 && <text x={L + gw * (k + 0.5)} y={y(0) - 6} textAnchor="middle" fontSize="10.5" fill="#9a5b00">{notes[k]}</text>}
                            {k % Math.max(1, Math.ceil(44 / gw)) === 0 && <text x={L + gw * (k + 0.5)} y={height - 6} textAnchor="middle" fontSize="11" fill={AXIS}>{c}</text>}
                        </g>
                    ))}
                    {lines?.map((s) => <path key={s.name} d={s.values.map((v, k) => (num(v) === null ? "" : `${k && num(s.values[k - 1]) !== null ? "L" : "M"}${(L + gw * (k + 0.5)).toFixed(1)} ${y(num(v)!).toFixed(1)}`)).join("")} fill="none" stroke={s.color} strokeWidth={s.width ?? 2} strokeDasharray={s.dash} />)}
                    {refLine && <g><line x1={L} x2={W - R} y1={y(refLine.value)} y2={y(refLine.value)} stroke="#c50f1f" strokeDasharray="5 4" opacity="0.7" /><text x={W - R - 4} y={y(refLine.value) - 4} textAnchor="end" fontSize="10.5" fill="#c50f1f">{refLine.label}</text></g>}
                </svg>
                {hover !== null && (
                    <div className="absolute top-1 pointer-events-none bg-popover border border-border rounded-sm shadow-md px-2.5 py-1.5 text-100 z-10"
                        style={{ left: `${((L + gw * (hover + 0.5)) / W) * 100}%`, transform: hover > cats.length * 0.6 ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}>
                        <div className="font-mono mb-0.5">{cats[hover]}</div>
                        {[...bars, ...(lines ?? [])].map((s) => { const v = num(s.values[hover]); return <div key={s.name} className="flex gap-2 justify-between whitespace-nowrap"><span style={{ color: s.color }}>{s.name}</span><b className="tabular-nums">{v === null ? "—" : fmtN(v, decimals)}</b></div>; })}
                    </div>
                )}
            </div>
        </div>
    );
}

/** Scatter of y against x with an optional 1:1 line. */
export function Scatter({ x, y, xLabel, yLabel, oneToOne, height = 300, color = PALETTE[0] }: { x: (number | null | string)[]; y: (number | null | string)[]; xLabel: string; yLabel: string; oneToOne?: boolean; height?: number; color?: string }) {
    const [box, W] = useWidth(640);
    const L = 56, R = 12, T = 10, B = 34;
    const pts = x.map((v, i) => [num(v), num(y[i])] as const).filter((p): p is readonly [number, number] => p[0] !== null && p[1] !== null);
    const mx = Math.max(1, ...pts.map((p) => Math.max(p[0], p[1]))) * 1.04;
    const X = (v: number) => L + (v / mx) * (W - L - R), Y = (v: number) => T + (1 - v / mx) * (height - T - B);
    return (
        <div ref={box}><svg viewBox={`0 0 ${W} ${height}`} className="w-full h-auto block" role="img" aria-label={`Scatter: ${yLabel} against ${xLabel}`}>
            {niceTicks(0, mx).map((v) => <g key={v}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke={GRID} /><text x={L - 6} y={Y(v) + 4} textAnchor="end" fontSize="11" fill={AXIS}>{fmtN(v)}</text><text x={X(v)} y={height - 18} textAnchor="middle" fontSize="11" fill={AXIS}>{fmtN(v)}</text></g>)}
            {oneToOne && <line x1={X(0)} y1={Y(0)} x2={X(mx)} y2={Y(mx)} stroke="#e8740c" strokeWidth="1.5" />}
            {pts.map((p, i) => <circle key={i} cx={X(p[0])} cy={Y(p[1])} r="2.2" fill={color} opacity="0.45" />)}
            <text x={(L + W - R) / 2} y={height - 3} textAnchor="middle" fontSize="11" fill={AXIS}>{xLabel}{oneToOne ? " · orange line = 1:1" : ""}</text>
            <text x={12} y={T + (height - T - B) / 2} textAnchor="middle" fontSize="11" fill={AXIS} transform={`rotate(-90 12 ${T + (height - T - B) / 2})`}>{yLabel}</text>
        </svg></div>
    );
}

export type CellState = "valid" | "low" | "fail" | "missing" | "excluded" | "none";
export const CELL_COLORS: Record<CellState, string> = {
    valid: "#2a9d8f", low: "color-mix(in srgb, #2a9d8f 14%, var(--color-card))", fail: "#aab6c2", missing: "#e8740c", excluded: "#8a4fbf", none: "transparent",
};
const CELL_LABEL: Record<CellState, string> = { valid: "valid", low: "night / below the POA floor", fail: "daylight, fails a criterion", missing: "missing or filtered-out data", excluded: "excluded by hand", none: "" };

/** One row per day, one cell per interval. */
export function Heatmap({ days, perDay, state, onPick }: { days: number[]; perDay: number; state: (day: number, k: number) => CellState; onPick?: (day: number) => void }) {
    return (
        <div>
            <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-100 text-muted-foreground mb-2">
                {(["valid", "low", "fail", "missing", "excluded"] as CellState[]).map((s) => <span key={s} className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px] border border-border" style={{ background: CELL_COLORS[s] }} />{CELL_LABEL[s]}</span>)}
            </div>
            <div className="overflow-x-auto">
                <div className="grid gap-px min-w-[560px] items-center" style={{ gridTemplateColumns: `52px repeat(${perDay}, minmax(0, 1fr))` }}>
                    {days.map((d) => (
                        <div key={d} className="contents">
                            <button type="button" className="text-100 text-muted-foreground font-mono text-left hover:text-foreground" onClick={() => onPick?.(d)} title={onPick ? "Zoom the charts to this day" : undefined}>{dd(d * 1440)}</button>
                            {Array.from({ length: perDay }, (_, k) => { const s = state(d, k); return <div key={k} className="h-3 rounded-[1px]" style={{ background: CELL_COLORS[s] }} title={`${dd(d * 1440)} ${hm(d * 1440 + ((k + 1) * 1440) / perDay)} · ${CELL_LABEL[s]}`} />; })}
                        </div>
                    ))}
                    <span />
                    {Array.from({ length: perDay }, (_, k) => <span key={k} className="text-[9.5px] text-muted-foreground text-center">{(k + 1) % (perDay / 4) === 0 && k + 1 < perDay ? `${String(((k + 1) * 24 / perDay) % 24).padStart(2, "0")}h` : ""}</span>)}
                </div>
            </div>
        </div>
    );
}
