# Pipeline PR — Progreso y estado (sesión 23/07/2026)

> Handoff generado para volcar a Notion (proyecto **Pvsyst**). Todo lo marcado ✅ está desplegado en Fabric y verificado en vivo.

## Contexto: qué estaba fallando en la app
- **PL2**: a partir del 25/06/26 salían filas mal (PR −100%) o no salían.
- **FRA**: no salía nada.

Causa raíz (tres problemas encadenados):
1. **La fuente SCADA renombró la columna de energía el 26/06/2026.** Hasta el 25/06 la energía venía en `E_GRID_01` (PL2) y `AP_01` (FRA); desde el 26/06 esas columnas quedan vacías y el dato pasa a una columna nueva `E_GRID`. `pr_runner` leía solo la columna vieja → energía medida = 0 desde el 26/06 → PR = −100%.
2. **FRA con `nvalid=0`** por el criterio c9 (Factor de Potencia) y por el timeshift mal configurado.
3. **PR de FRA errático** (118–273 %) por el desfase temporal PVsyst↔medido no aplicado.

## Resuelto y verificado ✅
| Ítem | Detalle | Estado |
|---|---|---|
| Energía (renombrado E_GRID) | Fix `coalesce(sensor_mapeado, E_GRID)` en `pr_runner`. Cae al sensor viejo solo donde `E_GRID` falta (FRA 01–25/06). | ✅ PL2 y FRA |
| Duplicados | Verificado: 0 duplicados. El salto de filas era más histórico ingerido (FRA desde 21/04, PL2 desde 01/02), no duplicación. | ✅ |
| c9 / PF FRA | Mapping `PF_01→PF`; c9 en `scada_proc` hardcodeado a la columna `PF`; c9=True en T04; reproceso de `scada_proc`. | ✅ |
| Timeshift FRA | T08 FRA = 180 min con start/end. Aplicado vía borrado selectivo de FRA en proc_pvsyst/raw_pvsyst/ingested_files + re-ingesta + PR_calculation. | ✅ |

### Resultados finales (run 23/07 ~13:53)
- **PL2**: PR global **102,6 %**, energía correcta desde el 26/06.
- **FRA**: PR global **121 % → 104,3 %**; `proc_pvsyst.time_shift = 180`; PR diario coherente **~100–110 %** en días despejados (antes 118–273 %).

## Pendiente (no son bugs del pipeline)
- **FRA 01–08/07**: `nvalid=0` real por blackout de sensores (POA_03/04 muertos + huecos de GHI) ya en `scada_raw` (origen). No rellenable.
- **Días nubosos de julio** (13–17/07, nvalid 3–7): PR más disperso (48–120 %) por poco muestreo. Esperable.

## Pendiente operativo (depende de acción manual)
- [ ] Commitear al repo los fixes desplegados vía `fab import`: `pr_runner`, `scada_proc` (evitar drift git↔Fabric).
- [ ] Desplegar PVsyst 8.1.4 en prod (reemplazo de ruta 8.1.2→8.1.4 en los `.bat` de `PVSyst_CLI\scripts`).

## Notas técnicas / gotchas aprendidos
- **`PR_calculation` NO reprocesa `scada_proc`.** Un cambio de criterios (T04/all_valid) exige correr `scada_proc.Notebook` aparte (por defecto `incremental=False` = full) y luego relanzar el pipeline.
- **`csv_ingest` es incremental por `ingested_files`.** Salta los CSV ya ingeridos → un cambio de timeshift NO entra solo relanzando el pipeline. Además el timeshift desplaza las fechas, así que un re-ingest simple dejaría filas viejas (ts=0) huérfanas; por eso se borra FRA de proc_pvsyst/raw_pvsyst/ingested_files antes de re-ingerir.
- **`meteo_export` NO escribe en las tablas scada**: solo lee `scada_proc` y publica un CSV a SharePoint vía Graph.
- **`scada_ingest`/`scada_proc`** escriben con MERGE (upsert) por `plant_code + Date`: actualizan existentes + insertan nuevas, nunca duplican.
- No subir `plants_config.xlsx` a SharePoint: lo edita el usuario.
