import { describe, expect, it } from "vitest";
import { FabricStore, decodePayload, encodePayload, type DataApi } from "./store";
import { defaultConfig } from "./presets";

/** In-memory stand-in for the Rayfin data API (same calls, paging included). */
function fakeApi() {
    const tables: Record<string, Map<string, Record<string, unknown>>> = { Project: new Map(), ProjectChunk: new Map() };
    let n = 0;
    const entity = (name: string) => {
        const rows = tables[name];
        const query = (where: Record<string, { eq: unknown }> = {}, after = 0, size = 100) => {
            const all = [...rows.values()].filter((r) => Object.entries(where).every(([k, v]) => r[k] === v.eq));
            const items = all.slice(after, after + size);
            return { items, hasNextPage: after + size < all.length, endCursor: String(after + size) };
        };
        const q = (st: { where?: Record<string, { eq: unknown }>; after?: number; size?: number }) => ({
            where: (w: Record<string, { eq: unknown }>) => q({ ...st, where: w }),
            orderBy: () => q(st),
            first: (k: number) => q({ ...st, size: Math.min(k, 3) }), // tiny pages to exercise paging
            after: (c: string) => q({ ...st, after: Number(c) }),
            executePaginated: async () => query(st.where, st.after, st.size),
        });
        return {
            select: () => q({}),
            create: async (v: Record<string, unknown>) => { const id = `id${++n}`; const r = { ...v, id }; rows.set(id, r); return r; },
            update: async (w: { id: string }, v: Record<string, unknown>) => { const r = { ...rows.get(w.id)!, ...v }; rows.set(w.id, r); return r; },
            delete: async (w: { id: string }) => rows.delete(w.id),
            findById: async (id: string) => rows.get(id) ?? null,
        };
    };
    return { api: { Project: entity("Project"), ProjectChunk: entity("ProjectChunk") } as unknown as DataApi, tables };
}

describe("project store", () => {
    it("round-trips a payload through gzip + base64 pieces", async () => {
        const big = { rows: Array.from({ length: 20000 }, (_, i) => [i, `26-07-2026 ${i}`, Math.sin(i) * 900]) };
        const pieces = await encodePayload(big);
        expect(pieces.length).toBeGreaterThan(1);
        expect(pieces.every((p) => p.length <= 3900)).toBe(true);
        expect(await decodePayload(pieces)).toEqual(big);
    });

    it("saves, reloads, replaces and deletes a project", async () => {
        const { api, tables } = fakeApi();
        const store = new FabricStore(api, () => "Raquel");
        const cfg = defaultConfig("EPI");
        cfg.project.name = "Demo";
        const meta = { name: "Demo", testType: "EPI" as const };
        let p = await store.create(meta);
        const scada = { fileNames: ["a.xlsx"], headers: ["Fecha", "POA"], rows: Array.from({ length: 5000 }, (_, i) => [`${i}`, i * 1.5]), dateCol: 0 };
        p = await store.save(p, "scada", scada, meta);
        p = await store.save(p, "config", cfg, meta);
        expect((await store.list()).map((x) => x.name)).toEqual(["Demo"]);
        const back = await store.load(p);
        expect(back.config.project.name).toBe("Demo");
        expect(back.scada).toEqual(scada);
        expect(back.pvsyst).toBeNull();

        // A new copy replaces the old one; old pieces are purged
        cfg.project.name = "Demo 2";
        p = await store.save(p, "config", cfg, { ...meta, name: "Demo 2" });
        await new Promise((r) => setTimeout(r, 20));
        expect((await store.load(p)).config.project.name).toBe("Demo 2");
        const cfgChunks = [...tables.ProjectChunk.values()].filter((r) => r.kind === "config");
        expect(new Set(cfgChunks.map((r) => r.version))).toEqual(new Set([2]));

        await store.remove(p);
        expect(tables.Project.size).toBe(0);
        expect(tables.ProjectChunk.size).toBe(0);
    });
});
