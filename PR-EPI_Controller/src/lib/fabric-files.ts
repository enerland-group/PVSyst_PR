//-----------------------------------------------------------------------
// Descarga del Excel de trazabilidad desde OneLake (DFS / ADLS Gen2 API):
// lista la carpeta TRACEABILITY/<plant> y baja el .xlsx más reciente.
//
// TOKEN: OneLake exige un bearer de Entra (scope storage). Se resuelve en
// `getFabricToken()` (ver fabric-token.ts) vía MSAL — login una vez y
// renovación silenciosa. El token de Rayfin NO sirve para OneLake.
//-----------------------------------------------------------------------

import { oneLake } from "@/lib/onelake.config";
import { getFabricToken } from "@/lib/fabric-token";

export { getFabricToken };

const FS = `${oneLake.baseUrl}/${oneLake.workspaceId}`;

interface DfsPath {
    name: string;
    lastModified?: string;
    isDirectory?: string;
    contentLength?: string;
}

/** Lista la carpeta de la planta y descarga el .xlsx de trazabilidad más reciente. */
export async function downloadLatestTraceability(plant: string, onStatus?: (m: string) => void): Promise<void> {
    const token = await getFabricToken();
    const auth = { Authorization: `Bearer ${token}` };
    const dir = `${oneLake.lakehouseId}/${oneLake.traceabilityDir}/${plant}`;

    onStatus?.(`Buscando el Excel más reciente de ${plant}…`);
    const listUrl = `${FS}?resource=filesystem&recursive=false&directory=${encodeURIComponent(dir)}`;
    const lr = await fetch(listUrl, { headers: auth });
    if (!lr.ok) throw new Error(`OneLake list ${lr.status}: ${(await lr.text()).slice(0, 200)}`);
    const data = (await lr.json()) as { paths?: DfsPath[] };

    const files = (data.paths ?? []).filter(
        (p) => p.isDirectory !== "true" && p.name.toLowerCase().endsWith(".xlsx"),
    );
    if (!files.length) throw new Error(`No hay Excel de trazabilidad para «${plant}» en OneLake.`);

    // El nombre incluye la fecha (…_YYYYMMDD-YYYYMMDD.xlsx) → orden lexicográfico desc = más reciente.
    files.sort((a, b) => b.name.localeCompare(a.name));
    const latest = files[0];
    const fileName = latest.name.split("/").pop() ?? "traceability.xlsx";

    onStatus?.(`Descargando ${fileName}…`);
    const fileUrl = `${FS}/${latest.name.split("/").map(encodeURIComponent).join("/")}`;
    const dl = await fetch(fileUrl, { headers: auth });
    if (!dl.ok) throw new Error(`OneLake read ${dl.status}: ${(await dl.text()).slice(0, 200)}`);

    const blob = await dl.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    onStatus?.(`✓ Descargado ${fileName}`);
}
