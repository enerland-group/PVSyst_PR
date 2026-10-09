//-----------------------------------------------------------------------
// Saved projects. In Fabric they live in the app's own SQL database
// (Rayfin entities Project + ProjectChunk, see rayfin/data). In the local
// preview (VITE_PR_MOCK=1) they live in the browser (IndexedDB).
//
// Each project keeps four payloads: the configuration and the imported
// SCADA, PVsyst and meter tables. A payload is JSON → gzip → base64, split
// in pieces of 3,900 characters (text columns need a maximum length).
// Writing a new copy never touches the old one until the new one is
// complete; then the project points to it and the old pieces are deleted.
//-----------------------------------------------------------------------

import type { ModelConfig, PvsystTable, RawTable } from "./types";

export type PayloadKind = "config" | "scada" | "pvsyst" | "meter";
export const KINDS: PayloadKind[] = ["config", "scada", "pvsyst", "meter"];

export interface ProjectMeta {
    id: string;
    name: string;
    code?: string;
    testType: "EPI" | "PR";
    country?: string;
    client?: string;
    procedure?: string;
    stage?: string;
    periodStart?: string;
    periodEnd?: string;
    result?: string;
    configVersion: number;
    scadaVersion: number;
    pvsystVersion: number;
    meterVersion: number;
    updatedBy?: string;
    createdAt: string;
    updatedAt: string;
}

export interface ProjectContent {
    config: ModelConfig;
    scada: RawTable | null;
    pvsyst: PvsystTable | null;
    meter: RawTable | null;
}

export type MetaFields = Pick<ProjectMeta, "name" | "code" | "testType" | "country" | "client" | "procedure" | "stage" | "periodStart" | "periodEnd" | "result">;

export interface ProjectStore {
    readonly where: string;
    list(): Promise<ProjectMeta[]>;
    create(meta: MetaFields): Promise<ProjectMeta>;
    /** Save one payload (null = remove it) and update the summary fields. */
    save(p: ProjectMeta, kind: PayloadKind, value: unknown, meta: MetaFields): Promise<ProjectMeta>;
    load(p: ProjectMeta): Promise<ProjectContent>;
    remove(p: ProjectMeta): Promise<void>;
}

const VERSION_FIELD: Record<PayloadKind, "configVersion" | "scadaVersion" | "pvsystVersion" | "meterVersion"> = {
    config: "configVersion", scada: "scadaVersion", pvsyst: "pvsystVersion", meter: "meterVersion",
};
const PIECE = 3900;

// ── Encoding ───────────────────────────────────────────────────────────
async function gzip(text: string): Promise<Uint8Array> {
    const s = new Response(text).body!.pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzip(bytes: Uint8Array): Promise<string> {
    const s = new Response(bytes as BodyInit).body!.pipeThrough(new DecompressionStream("gzip"));
    return await new Response(s).text();
}
function toB64(b: Uint8Array): string {
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
}
function fromB64(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
export async function encodePayload(value: unknown): Promise<string[]> {
    const b64 = toB64(await gzip(JSON.stringify(value)));
    const pieces: string[] = [];
    for (let i = 0; i < b64.length; i += PIECE) pieces.push(b64.slice(i, i + PIECE));
    return pieces.length ? pieces : [""];
}
export async function decodePayload<T>(pieces: string[]): Promise<T> {
    return JSON.parse(await gunzip(fromB64(pieces.join("")))) as T;
}

/** Run async jobs with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<unknown>) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// ── Fabric (Rayfin data API) ───────────────────────────────────────────
interface Chunk { id?: string; project_id: string; kind: PayloadKind; version: number; seq: number; total: number; data: string }

/* The data API is typed from rayfin/data/schema.ts on the backend; here a minimal shape is enough. */
type Q<T> = {
    where(w: Record<string, unknown>): Q<T>;
    orderBy(o: Record<string, "asc" | "desc">): Q<T>;
    first(n: number): Q<T>;
    after(c: string): Q<T>;
    executePaginated(): Promise<{ items: T[]; endCursor?: string | null; hasNextPage: boolean }>;
};
type Entity<T> = {
    select(fields: string[]): Q<T>;
    create(v: Partial<T>): Promise<T>;
    update(w: { id: string }, v: Partial<T>): Promise<T>;
    delete(w: { id: string }): Promise<unknown>;
    findById(id: string): Promise<T | null>;
};
export interface DataApi { Project: Entity<ProjectMeta>; ProjectChunk: Entity<Chunk> }

async function all<T>(q: () => Q<T>): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null | undefined;
    for (;;) {
        let qq = q().first(1000);
        if (cursor) qq = qq.after(cursor);
        const page = await qq.executePaginated();
        out.push(...page.items);
        if (!page.hasNextPage || !page.endCursor) return out;
        cursor = page.endCursor;
    }
}
const META_FIELDS = ["id", "name", "code", "testType", "country", "client", "procedure", "stage", "periodStart", "periodEnd", "result", "configVersion", "scadaVersion", "pvsystVersion", "meterVersion", "updatedBy", "createdAt", "updatedAt"];
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ""));
const normMeta = (m: ProjectMeta): ProjectMeta => ({ ...m, createdAt: iso(m.createdAt), updatedAt: iso(m.updatedAt), configVersion: m.configVersion ?? 0, scadaVersion: m.scadaVersion ?? 0, pvsystVersion: m.pvsystVersion ?? 0, meterVersion: m.meterVersion ?? 0 });

export class FabricStore implements ProjectStore {
    readonly where = "the app's database in Fabric (PVSyst - PR workspace)";
    constructor(private api: DataApi, private user: () => string) {}

    async list() {
        const rows = await all(() => this.api.Project.select(META_FIELDS).orderBy({ updatedAt: "desc" }));
        return rows.map(normMeta);
    }
    async create(meta: MetaFields) {
        const now = new Date();
        const p = await this.api.Project.create({ ...meta, configVersion: 0, scadaVersion: 0, pvsystVersion: 0, meterVersion: 0, updatedBy: this.user(), createdAt: now as unknown as string, updatedAt: now as unknown as string });
        return normMeta(p);
    }
    async save(p: ProjectMeta, kind: PayloadKind, value: unknown, meta: MetaFields) {
        const field = VERSION_FIELD[kind];
        const old = p[field];
        const version = old + 1;
        if (value !== null) {
            const pieces = await encodePayload(value);
            await pool(pieces.map((data, seq) => ({ data, seq })), 6, (x) =>
                this.api.ProjectChunk.create({ project_id: p.id, kind, version, seq: x.seq, total: pieces.length, data: x.data }));
        }
        const upd = await this.api.Project.update({ id: p.id }, { ...meta, [field]: value === null ? 0 : version, updatedBy: this.user(), updatedAt: new Date() as unknown as string });
        // Old copies are removed only after the project points to the new one
        void this.purge(p.id, kind, value === null ? -1 : version).catch(() => undefined);
        return normMeta({ ...p, ...upd });
    }
    private async purge(projectId: string, kind: PayloadKind, keep: number) {
        const rows = await all(() => this.api.ProjectChunk.select(["id", "version"]).where({ project_id: { eq: projectId }, kind: { eq: kind } }));
        await pool(rows.filter((r) => r.version !== keep), 6, (r) => this.api.ProjectChunk.delete({ id: r.id! }));
    }
    private async read<T>(projectId: string, kind: PayloadKind, version: number): Promise<T | null> {
        if (!version) return null;
        const rows = await all(() => this.api.ProjectChunk.select(["seq", "total", "data"]).where({ project_id: { eq: projectId }, kind: { eq: kind }, version: { eq: version } }));
        if (!rows.length) return null;
        rows.sort((a, b) => a.seq - b.seq);
        if (rows.length !== rows[0].total) throw new Error(`The saved ${kind} data of this project is incomplete (${rows.length} of ${rows[0].total} pieces).`);
        return decodePayload<T>(rows.map((r) => r.data));
    }
    async load(p: ProjectMeta) {
        const fresh = normMeta((await this.api.Project.findById(p.id)) ?? p);
        const [config, scada, pvsyst, meter] = await Promise.all([
            this.read<ModelConfig>(fresh.id, "config", fresh.configVersion),
            this.read<RawTable>(fresh.id, "scada", fresh.scadaVersion),
            this.read<PvsystTable>(fresh.id, "pvsyst", fresh.pvsystVersion),
            this.read<RawTable>(fresh.id, "meter", fresh.meterVersion),
        ]);
        if (!config) throw new Error("This project has no saved configuration.");
        return { config, scada, pvsyst, meter };
    }
    async remove(p: ProjectMeta) {
        for (const k of KINDS) await this.purge(p.id, k, -1);
        await this.api.Project.delete({ id: p.id });
    }
}

// ── Browser (local preview) ────────────────────────────────────────────
function idb(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
        const r = indexedDB.open("pr-epi-model-builder", 1);
        r.onupgradeneeded = () => { r.result.createObjectStore("projects", { keyPath: "id" }); r.result.createObjectStore("payloads"); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}
function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return idb().then((db) => new Promise<T>((res, rej) => {
        const r = fn(db.transaction(store, mode).objectStore(store));
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    }));
}

export class BrowserStore implements ProjectStore {
    readonly where = "this browser (local preview only)";
    async list() {
        const rows = await tx<ProjectMeta[]>("projects", "readonly", (s) => s.getAll() as IDBRequest<ProjectMeta[]>);
        return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    async create(meta: MetaFields) {
        const now = new Date().toISOString();
        const p: ProjectMeta = { ...meta, id: crypto.randomUUID(), configVersion: 0, scadaVersion: 0, pvsystVersion: 0, meterVersion: 0, updatedBy: "Preview", createdAt: now, updatedAt: now };
        await tx("projects", "readwrite", (s) => s.put(p));
        return p;
    }
    async save(p: ProjectMeta, kind: PayloadKind, value: unknown, meta: MetaFields) {
        const field = VERSION_FIELD[kind];
        const version = value === null ? 0 : p[field] + 1;
        if (value !== null) await tx("payloads", "readwrite", (s) => s.put(value, `${p.id}|${kind}`));
        else await tx("payloads", "readwrite", (s) => s.delete(`${p.id}|${kind}`));
        const np: ProjectMeta = { ...p, ...meta, [field]: version, updatedAt: new Date().toISOString() };
        await tx("projects", "readwrite", (s) => s.put(np));
        return np;
    }
    async load(p: ProjectMeta) {
        const get = <T,>(k: PayloadKind) => tx<T | undefined>("payloads", "readonly", (s) => s.get(`${p.id}|${k}`) as IDBRequest<T | undefined>).then((v) => v ?? null);
        const config = await get<ModelConfig>("config");
        if (!config) throw new Error("This project has no saved configuration.");
        return { config, scada: await get<RawTable>("scada"), pvsyst: await get<PvsystTable>("pvsyst"), meter: await get<RawTable>("meter") };
    }
    async remove(p: ProjectMeta) {
        for (const k of KINDS) await tx("payloads", "readwrite", (s) => s.delete(`${p.id}|${k}`));
        await tx("projects", "readwrite", (s) => s.delete(p.id));
    }
}
