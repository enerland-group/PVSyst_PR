// Configuración de OneLake para la descarga del Excel de trazabilidad.
//
// NO va en fabric.generated.ts: ese fichero lo regenera `fabric-app-data generate`
// desde fabric.yaml en cada build y machacaría estos valores. Por eso vive aquí.
//
// Origen de los IDs (mismos que usan los notebooks de Fabric):
//   abfss://<workspaceId>@onelake.dfs.fabric.microsoft.com/<lakehouseId>
// y la carpeta de audit donde traceability_export deja los .xlsx:
//   /lakehouse/default/Files/traceability_audit/<plant>/

export const oneLake = {
    baseUrl: "https://onelake.dfs.fabric.microsoft.com",
    workspaceId: "0c4c3bbe-a6ae-404f-b1b7-7052bacfea11", // PVSyst - PR
    lakehouseId: "ae7e1482-8f15-4b1b-8954-8ee500382179", // pvsyst
    traceabilityDir: "Files/traceability_audit",
} as const;
