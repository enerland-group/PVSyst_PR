//-----------------------------------------------------------------------
// Small UI kit for the model builder (same look as the dashboard:
// mono uppercase labels, left blue bars, navy header).
//-----------------------------------------------------------------------

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { clsx as cn } from "clsx";

/** Field label: one line, same height everywhere so the inputs below line up. */
export function Label({ children, info }: { children: ReactNode; info?: ReactNode }) {
    return (
        <span className="flex items-center gap-1.5 h-[18px] font-mono text-100 uppercase tracking-[0.12em] text-muted-foreground mb-1 whitespace-nowrap">
            <span className="truncate">{children}</span>
            {info && <Info>{info}</Info>}
        </span>
    );
}

/** (i) badge; the explanation opens on hover or keyboard focus. Fixed position so tables don't clip it. */
export function Info({ children }: { children: ReactNode }) {
    const ref = useRef<HTMLSpanElement>(null);
    const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null);
    const open = () => {
        const r = ref.current?.getBoundingClientRect();
        if (!r) return;
        const w = 360;
        const x = Math.max(8, Math.min(r.left - 12, window.innerWidth - w - 8));
        const up = r.bottom + 220 > window.innerHeight && r.top > 240;
        setPos({ x, y: up ? r.top - 8 : r.bottom + 8, up });
    };
    return (
        <span
            ref={ref}
            tabIndex={0}
            role="button"
            aria-label="More information"
            onMouseEnter={open}
            onMouseLeave={() => setPos(null)}
            onFocus={open}
            onBlur={() => setPos(null)}
            className="inline-grid place-items-center w-[15px] h-[15px] shrink-0 rounded-full bg-muted border border-border text-brand-foreground italic font-bold text-[10px] leading-none normal-case tracking-normal cursor-help outline-none focus:ring-2 focus:ring-ring"
        >
            i
            {pos && (
                <span
                    role="tooltip"
                    style={{ left: pos.x, top: pos.y, transform: pos.up ? "translateY(-100%)" : undefined }}
                    className="fixed z-50 w-[360px] max-w-[calc(100vw-16px)] rounded-md bg-[#1f2733] text-[#eef2f6] px-3.5 py-3 text-200 leading-relaxed font-sans not-italic font-normal normal-case tracking-normal text-left whitespace-normal shadow-lg [&_b]:text-white [&_.ex]:block [&_.ex]:mt-2 [&_.ex]:pt-2 [&_.ex]:border-t [&_.ex]:border-white/15 [&_.ex]:text-[#cfe3f7]"
                >
                    {children}
                </span>
            )}
        </span>
    );
}

export function Hint({ children, className }: { children: ReactNode; className?: string }) {
    return <p className={cn("text-200 text-muted-foreground mb-3.5 max-w-[80ch]", className)}>{children}</p>;
}

export function Explain({ children }: { children: ReactNode }) {
    return <div className="border border-border bg-secondary rounded-sm px-3 py-2.5 text-200 mb-3.5 leading-relaxed">{children}</div>;
}

export function Grid({ children, min = 190 }: { children: ReactNode; min?: number }) {
    return <div className="grid gap-3.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>{children}</div>;
}

const inputBase = "border border-border rounded-sm bg-card text-foreground tabular-nums outline-none focus:ring-2 focus:ring-ring";
const inputCls = `w-full px-2.5 py-1.5 text-300 ${inputBase}`;
const inputCompact = `px-1.5 py-1 text-200 ${inputBase}`;

export function TextField({ label, value, onChange, unit, placeholder, info }: { label: string; value: string; onChange: (v: string) => void; unit?: string; placeholder?: string; info?: ReactNode }) {
    const id = useId();
    return (
        <label htmlFor={id} className="block min-w-0">
            <Label info={info}>{label}</Label>
            <input id={id} className={inputCls} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
            {unit && <span className="block text-100 text-muted-foreground mt-1">{unit}</span>}
        </label>
    );
}

/** Numeric input that keeps the typed text until it parses (allows "-", "0.", etc.). Optional scale for % fields. */
export function NumField({ label, value, onChange, unit, suffix, info, scale = 1, step, compact, ariaLabel, commitOnBlur }: {
    label?: string; value: number; onChange: (v: number) => void; unit?: string; suffix?: string; info?: ReactNode; scale?: number; step?: number; compact?: boolean; ariaLabel?: string;
    /** Apply the value only on Enter / leaving the field (for inputs whose intermediate values are meaningless, e.g. "-6" while typing "-60"). */
    commitOnBlur?: boolean;
}) {
    const fmt = (v: number) => (Number.isFinite(v) ? String(Math.round(v * scale * 1e9) / 1e9) : "");
    const [text, setText] = useState(fmt(value));
    const last = useRef(value);
    useEffect(() => { if (value !== last.current) { setText(fmt(value)); last.current = value; } }); // eslint-disable-line react-hooks/exhaustive-deps
    const id = useId();
    const input = (
        <input
            id={id}
            aria-label={ariaLabel ?? label}
            inputMode="decimal"
            step={step}
            className={compact ? `${suffix ? "w-[58px] border-0 focus:ring-0" : `w-[78px] ${inputCompact}`}` : suffix ? "w-full min-w-0 px-2.5 py-1.5 text-300 bg-transparent text-foreground tabular-nums outline-none" : inputCls}
            value={text}
            onChange={(e) => {
                const t = e.target.value;
                setText(t);
                const n = Number(t.replace(",", "."));
                if (!commitOnBlur && t.trim() !== "" && Number.isFinite(n)) { last.current = n / scale; onChange(n / scale); }
            }}
            onKeyDown={(e) => { if (commitOnBlur && e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            onBlur={() => {
                if (commitOnBlur) {
                    const n = Number(text.replace(",", "."));
                    if (text.trim() !== "" && Number.isFinite(n) && n / scale !== last.current) { last.current = n / scale; onChange(n / scale); }
                }
                setText(fmt(last.current));
            }}
        />
    );
    const withSuffix = suffix ? (
        <span className={cn("flex items-stretch border border-border rounded-sm bg-card overflow-hidden focus-within:ring-2 focus-within:ring-ring", compact ? "inline-flex" : "")}>
            {input}
            <span className={cn("flex items-center bg-secondary border-l border-border text-muted-foreground whitespace-nowrap", compact ? "px-1.5 text-100" : "px-2.5 text-200")}>{suffix}</span>
        </span>
    ) : input;
    if (compact) return withSuffix;
    return (
        <label htmlFor={id} className="block min-w-0">
            {label && <Label info={info}>{label}</Label>}
            {withSuffix}
            {unit && <span className="block text-100 text-muted-foreground mt-1">{unit}</span>}
        </label>
    );
}

export function SelectField<T extends string>({ label, value, options, onChange, unit, compact, info }: {
    label?: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; unit?: string; compact?: boolean; info?: ReactNode;
}) {
    const id = useId();
    const sel = (
        <select id={id} aria-label={label} className={compact ? `w-auto max-w-full ${inputCompact}` : inputCls} value={value} onChange={(e) => onChange(e.target.value as T)}>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
    );
    if (compact) return sel;
    return (
        <label htmlFor={id} className="block min-w-0">
            {label && <Label info={info}>{label}</Label>}
            {sel}
            {unit && <span className="block text-100 text-muted-foreground mt-1">{unit}</span>}
        </label>
    );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            onClick={() => onChange(!checked)}
            className={cn("relative w-[34px] h-5 rounded-full shrink-0 mt-0.5 transition-colors", checked ? "bg-primary" : "bg-border")}
        >
            <span className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white transition-[left]", checked ? "left-4" : "left-0.5")} />
        </button>
    );
}

export function Pill({ tone, children }: { tone: "ok" | "warn" | "info" | "mute" | "bad"; children: ReactNode }) {
    const c = { ok: "text-[#107c10] dark:text-[#6ccb5f]", warn: "text-[#9a5b00] dark:text-[#f2c661]", info: "text-brand-foreground", mute: "text-muted-foreground", bad: "text-destructive" }[tone];
    return <span className={cn("inline-block font-mono text-[10.5px] tracking-[0.08em] uppercase px-[7px] py-px rounded-full border border-current self-start", c)}>{children}</span>;
}

export function Btn({ children, onClick, kind = "default", disabled, title }: { children: ReactNode; onClick?: () => void; kind?: "default" | "primary" | "excel"; disabled?: boolean; title?: string }) {
    const k = {
        default: "bg-card border-border text-foreground hover:bg-accent",
        primary: "bg-primary border-primary text-primary-foreground hover:opacity-90",
        excel: "bg-[#1d6f42] border-[#1d6f42] text-white hover:opacity-90",
    }[kind];
    return (
        <button type="button" title={title} disabled={disabled} onClick={onClick} className={cn("border rounded-sm px-4 py-2 font-semibold text-300 disabled:opacity-40 disabled:cursor-not-allowed", k)}>
            {children}
        </button>
    );
}

export function Choice({ on, title, text, onClick, disabled }: { on: boolean; title: string; text: ReactNode; onClick: () => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={cn("text-left border-[1.5px] rounded-md px-3 py-2.5 flex flex-col gap-1 bg-card disabled:opacity-55 disabled:cursor-not-allowed", on ? "border-primary bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--color-card))]" : "border-border")}
        >
            <b className="text-300">{title}</b>
            <span className="text-200 text-muted-foreground">{text}</span>
        </button>
    );
}

export function FileDrop({ label, accept, multiple, files, meta, onFiles, busy }: {
    label: string; accept: string; multiple?: boolean; files: string[]; meta?: ReactNode; onFiles: (f: File[]) => void; busy?: boolean;
}) {
    const ref = useRef<HTMLInputElement>(null);
    const [over, setOver] = useState(false);
    const loaded = files.length > 0;
    return (
        <div
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const fs = Array.from(e.dataTransfer.files); if (fs.length) onFiles(fs); }}
            className={cn("border-[1.5px] rounded-md p-3.5 bg-card flex flex-col gap-1.5 min-w-0", loaded ? "border-solid border-[#107c10]" : "border-dashed border-border", over && "border-primary")}
        >
            <Label>{label}</Label>
            {loaded ? <FileList files={files} /> : <span className="text-200 text-muted-foreground">Drop {multiple ? "files" : "a file"} here or browse ({accept})</span>}
            {meta && <span className="text-200 text-muted-foreground">{meta}</span>}
            <div className="flex items-center gap-2 mt-1">
                <input ref={ref} type="file" accept={accept} multiple={multiple} className="hidden" onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) onFiles(fs); e.target.value = ""; }} />
                <Btn onClick={() => ref.current?.click()} disabled={busy}>{busy ? "Reading…" : loaded ? "Replace" : "Browse…"}</Btn>
                {loaded && <Pill tone="ok">Loaded</Pill>}
            </div>
        </div>
    );
}

function FileList({ files }: { files: string[] }) {
    const [all, setAll] = useState(false);
    const show = all || files.length <= 4 ? files : [files[0], files[files.length - 1]];
    return (
        <>
            {show.map((f, i) => (
                <span key={f} className="font-mono text-200 break-all">
                    {!all && files.length > 4 && i === 1 && <span className="block text-muted-foreground">… {files.length - 2} more …</span>}
                    {f}
                </span>
            ))}
            {files.length > 4 && <button type="button" className="text-100 text-brand-foreground text-left underline" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${files.length} files`}</button>}
        </>
    );
}

export function Formula({ children }: { children: ReactNode }) {
    return <code className="block mt-2 font-mono text-[11.5px] bg-secondary border border-border border-l-[3px] border-l-[#1d6f42] px-2 py-1.5 rounded-r-sm overflow-x-auto whitespace-pre">{children}</code>;
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
    return (
        <div className="overflow-x-auto border border-border rounded-sm">
            <table className="w-full border-collapse text-200">
                <thead>
                    <tr>{head.map((h, i) => <th key={i} className="font-mono text-100 uppercase tracking-[0.08em] text-muted-foreground text-left bg-secondary px-2.5 py-1.5 border-b border-border whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody className="[&_td]:px-2.5 [&_td]:py-1.5 [&_td]:border-b [&_td]:border-border [&_tr:last-child_td]:border-b-0">{children}</tbody>
            </table>
        </div>
    );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="border border-border rounded-sm px-2.5 py-2 bg-secondary">
            <span className="font-mono text-100 uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
            <b className="block text-500 tabular-nums" style={{ fontFamily: "var(--font-numeric)" }}>{value}</b>
        </div>
    );
}
