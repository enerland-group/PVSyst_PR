# notifier — versión Graph (sin depender de OneDrive sync)

Misma orquestación de PVsyst CLI que ya tenías, pero **sustituye los tres puntos donde dependía de OneDrive** por llamadas directas a Microsoft Graph contra el site SharePoint `Pvsyst1`.

## Qué cambia respecto a la versión OneDrive

| Punto | Antes (OneDrive) | Ahora (Graph) |
|---|---|---|
| **Entrada al INBOX** | El PC esperaba que OneDrive sincronizara los ficheros nuevos al INBOX local | Al inicio del ciclo, `descargar_meteo_inbox()` los baja **directamente** vía Graph |
| **Subida de resultados** | `shutil.copy2` a la biblioteca local sincronizada | `subir_resultados()` hace **Graph PUT** a `<Raw PVSyst1>/<Planta>/<file>` |
| **Subida de logs diarios** | Append en carpeta sincronizada (OneDrive subía cuando podía) | Al final del ciclo, `subir_log_a_sharepoint()` hace **Graph PUT** del log entero a `<LOGS>/log_<tipo>_<fecha>.txt` |
| Sleeps de 10–15 s (`forzar_sincronizacion`) | Necesarios para que OneDrive llegara | **Eliminados** — Graph es síncrono |

## Ficheros del paquete

```
main.py            ← orquestador, cambios mínimos
sharepoint.py      ← reescrito: ahora usa Graph
runner.py          ← sin cambios
notifier.py        ← sin cambios
test_webhook.py    ← sin cambios
```

`runner.py`, `notifier.py` y `test_webhook.py` están **bit-idénticos** a los originales. Solo `main.py` y `sharepoint.py` cambian.

## Pasos para migrar

### 1. Reemplaza los ficheros

Copia los nuevos `main.py` y `sharepoint.py` sobre los que tenías. Los demás los puedes dejar.

### 2. Añade el bloque `graph:` a tu `config.yaml`

Al **final** de tu `config.yaml`, añade:

```yaml
# === Microsoft Graph (sustituye a OneDrive como mecanismo de entrega) ===
graph:
  client_id:            "58f369e5-0dfd-4435-802b-a90a6786bf22"
  tenant_id:            "943fa85b-068d-404a-bacb-5f0baf8d31a8"
  site_path:            "enerlandgroup.sharepoint.com:/sites/Pvsyst1"
  drive_name:           "Documentos"

  # Subcarpetas dentro de la biblioteca:
  inbox_folder:         "inbox"           # entradas (lo que sube Fabric / lo que dejes manual)
  results_root_folder:  ""                # vacío = los resultados van a Documentos/<PLANTA>/<file>
  logs_folder:          "LOGS"            # logs diarios acumulados

  # Variable de entorno con el client_secret de la app PVSyst1_EPI:
  secret_env_var:       "PVSYST1_EPI_SECRET"
```

**No hace falta listar plantas**: `descargar_meteo_inbox()` baja todo lo que haya en `/inbox/` con extensiones de PVsyst (`.csv`, `.prj`, `.var*`, `.sit`, `.mef`, `.met`, `.sfi`, `.pan`, `.ond`, `.pdf`, `.xlsx`, `.xlsm`, `.docx`, `.txt`, `.md`). `main.py` ya las identifica por nombre como hacía antes.

### 3. Define el `client_secret` como variable de entorno

En PowerShell **como administrador**:

```powershell
setx PVSYST1_EPI_SECRET "auC8Q~0pj_p.2rDeMuYLDAWccapxdRR8sUQ9zbb1" /M
```

Cierra todas las consolas y abre una nueva. Verifica:

```powershell
echo %PVSYST1_EPI_SECRET%
```

⚠️ **Rota ese secret** después: ha estado expuesto en el chat. Genera uno nuevo en Azure Portal → App registrations → `PVSyst1_EPI` → Certificates & secrets, actualiza la env var y listo.

### 4. Instala `requests` (si no lo tienes)

```powershell
pip install requests
```

(Probablemente ya está porque `notifier.py` lo usa para Teams.)

### 5. Test rápido

```powershell
python -c "import sharepoint, yaml; print(sharepoint.descargar_meteo_inbox(yaml.safe_load(open('config.yaml','r',encoding='utf-8')), r'C:\PVsyst\inbox'))"
```

Si funciona, te baja al INBOX local los ficheros nuevos. Si falla, el mensaje indicará si es Graph (auth/permiso) o config (rutas).

### 6. Lanza el orquestador como siempre

```powershell
python main.py
```

Diferencia clave: ya **no** depende de OneDrive.

## Time-shift: T08_time_shifts → UsesDST de la MEF (o CSV raw corregido, si no es de fiar) + `-imt`

El desfase temporal de cada planta se declara **en un solo sitio**: la tabla
`T08_time_shifts` de `plants_config.xlsx` (`plant_code`, `time_shift` en minutos,
`start_date`, `end_date`). Las dos fechas son **los cambios de hora**: son los días
que hay que contrastar contra la MEF (y, si hiciera falta, contra el CSV).

El CLI solo admite `-imt` entre **−30 y +30 minutos**, así que el total se atiende
en dos sitios distintos:

```
horas enteras   ->  las resuelve PVsyst solo (UsesDST de la MEF), o si no es de
                    fiar, se corrigen a mano las FECHAS DEL CSV RAW (fallback)
resto [-30;+30] ->  -imt del convert-meteo, SIEMPRE, haga falta o no el fallback
```

**Probado con datos reales (FRA, PL1, PL2 — 31/07/2026): cuando la MEF declara
`UsesDST=True` + `RefTimeS=LegalTime` + `DateHEte`/`DateHHiver` coherentes con la
regla de la UE (último domingo de marzo/octubre, del año del propio cambio),
PVsyst ya resuelve ese cambio de hora él solo dentro de `run-simulation`.**
Reescribir el CSV en ese caso duplica la corrección (se aplica una vez a mano y
otra vez la aplica PVsyst) y descentra el resultado justo el doble de lo que
hacía falta — o hace que el CLI rechace el fichero directamente. Por eso
`timeshift.py` comprueba esto primero (`es_dst_fiable()`, en el propio script) y
solo cae al mecanismo antiguo de reescribir el CSV cuando la MEF no es de fiar
(campo que falta, año sin actualizar, fechas que no cuadran con la regla de la
UE...). En ese caso se avisa fuerte en el log — es una señal de que hay que
arreglar la MEF, no de que el fallback deba quedarse para siempre.

Cada fecha de T08 puede caer en tres sitios respecto al CSV, y en cada caso
`timeshift.py` hace algo distinto **dentro del fallback** (si UsesDST ya la
resuelve, no se llega a mirar nada de esto):

**a) La fecha cae DENTRO del CSV** → se mira qué hay de verdad en los datos:

| Lo que encuentra | Qué hace |
|---|---|
| Falta una hora (salto `02:00 → 03:00`, el reloj va adelante) | **Resta** 1 h a todas las filas siguientes |
| Hora repetida (el reloj vuelve atrás) | **Suma** 1 h a todas las filas siguientes |
| Ni una cosa ni la otra | **No corrige** la hora; deja un aviso en el log |

**b) La fecha es ANTERIOR al primer dato** → el reloj ya había cambiado cuando
empiezan los datos, así que **todas** las filas vienen con el desfase puesto: se
corrige desde la primera fila. El sentido lo da el lado del tramo (`start_date` =
el reloj se adelantó → resta; `end_date` = volvió atrás → suma), porque no hay
artefacto del que deducirlo. Es el caso de FRA: su CSV empieza el 21/04 y el
cambio fue el 29/03, así que se le resta 1 h al fichero entero.

**c) La fecha es POSTERIOR al último dato** → ese cambio no afecta a este fichero.

Las correcciones se acumulan, así que si el tramo se abrió **y** se cerró antes de
que empiecen los datos las dos se anulan y el CSV no cambia — que es justo lo
correcto.

Cadena completa, por CSV:

| Paso | Quién | Qué hace |
|---|---|---|
| 1 | `timeshift.py aplicar` (lo llama `auto_run.bat`) | Corrige los cambios de hora en una **copia** del CSV (`%TEMP%\pvsyst_tsfix\`) y devuelve los minutos sueltos. El original no se toca; **el MEF tampoco** |
| 2 | `auto_run.bat` | `convert-meteo -icf:<copia> ... -imt:<resto>` (se omite si el resto es 0). La copia se borra al terminar |
| 3 | Fabric `csv_ingest` | Deshace el `-imt` y luego las horas de cada tramo, leyendo la MISMA tabla |

O sea: el desplazamiento existe **solo dentro de PVsyst**, para que la simulación
use la posición solar correcta. Las fechas que llegan a `proc_pvsyst` y al cálculo
de PR vuelven a la escala de tiempo del SCADA, así que el PR compara hora contra
hora sin sesgo. Verificado con round-trip sobre los dos CSV reales: PL2 (cruza el
cambio de hora, 3.979 filas horarias) y FRA (entero dentro del tramo, 2.376 filas)
vuelven exactamente a su hora de origen.

Detalles que importan:

- **Varios tramos se simulan enteros.** La corrección de horas es acumulativa y por
  posición en el fichero, así que un CSV que cruce varios cambios de hora se
  corrige tramo a tramo, y `csv_ingest` lo revierte igual, fila a fila. El único
  valor global es el `-imt` (el CLI no admite más de uno por conversión).
- **Los tramos se cortan a las 02:00**, no a medianoche, en las dos puntas: es la
  hora del cambio en la UE. Cortarlos a día completo desalinearía la madrugada del
  día del cambio, que la conversión no llegó a mover.
- **Un corte de datos no es un cambio de hora.** Solo se acepta como cambio de hora
  un salto de ≤ 2 h que caiga entre las 00:00 y las 06:00 (en la UE el cambio es a
  las 02:00). Sin eso, el corte de exactamente una hora que tiene PL2 el 17/05 a
  las 18:45 se habría tomado por un cambio de hora.
- **La costura se limpia.** Al cerrar un hueco, la primera fila desplazada cae sobre
  la que ya estaba (en PL2, el `03:00` se convierte en un segundo `02:00`): son la
  misma medida emitida dos veces, y la duplicada se elimina. Un meteo con etiquetas
  repetidas es justo lo que hace que PVsyst rechace el fichero.
- **Se aborta el CSV si algo no cuadra** (Excel inaccesible, CSV ilegible…). El
  fichero se queda en el `/inbox/` de SharePoint y se reintenta en el ciclo
  siguiente. Simular sin saber el desfase falsearía el PR sin avisar.
- **El MEF no se escribe, solo se lee.** Se lee `UsesDST`/`RefTimeS`/`DateHEte`/
  `DateHHiver` para decidir si PVsyst resuelve el cambio de hora solo. Si la MEF
  trae `HourShiftF` o `TimeShiftF`, eso es un desfase de más que nadie gestiona
  (residuo de versiones antiguas del script, que sí escribían ahí): se avisa en
  el log y no se toca — pero conviene limpiarlo a mano, porque PVsyst lo sigue
  aplicando por encima de todo lo demás.
- El `TimeShift` del fichero de variante (`VXX`) **no se usa**; se registra en el
  log solo como traza.

### Qué se ve en el log

Una línea por CSV, más los avisos si los hay:

```
[TIME-SHIFT] FRA: -1 h en todo el fichero, -imt:1
[TIME-SHIFT] PL2: -1 h desde 29/03, -imt:6
```

El detalle (filas de T08, fechas revisadas, líneas desplazadas, ruta de la copia…)
se guarda siempre y **se vuelca entero si algo falla**, para poder diagnosticarlo
sin repetir la corrida. A mano se puede pedir con `-v`.

Consultas y diagnóstico:

```powershell
python timeshift.py mostrar                      # T08 y el reparto de cada planta
python timeshift.py revisar PL2 --csv <csv>      # qué hay en las fechas de T08
python timeshift.py aplicar PL2 --csv <csv> -v   # el detalle completo de una corrida
python check_timeshift.py PL2 --csv <csv>        # mide el centrado real y dice
                                                 # cuánto corregir en T08
```

`revisar` es el que conviene mirar primero cuando una planta no cuadra: dice, para
cada fecha de T08, si hay cambio de hora y de qué tipo, sin escribir nada.

**Sin dependencias nuevas**: si `openpyxl` está instalado se usa, y si no
`timeshift.py` lee el `.xlsx` con la librería estándar (un xlsx es un zip de XML;
busca la tabla por `displayName` y convierte las fechas desde el número de serie
de Excel). Los dos caminos dan el mismo resultado — verificado contra el
`plants_config.xlsx` real. La única excepción es un Excel guardado con el sistema
de fechas **1904** (Excel de Mac): ahí aborta pidiendo `openpyxl`.

Sí hace falta acceso a `<CONFIG>/plants_config.xlsx` en SharePoint (o una copia
local apuntada con `paths.plants_config`). La descarga se cachea en
`paths.plants_config_cache`, que se usa como red de seguridad si Graph falla
puntualmente.

## Idempotencia

`sharepoint.py` guarda en `%APPDATA%\PVSyst1_sync\last_meteo.json` qué ficheros se bajaron por última vez (clave = nombre, valor = lastModifiedDateTime).

- Si el cron se dispara dos veces sin que Fabric haya regenerado nada → segunda ejecución no reprocesa.
- Si en SharePoint regeneraste un fichero (mismo nombre, distinto `lastModifiedDateTime`) → se considera nuevo y se baja.

**Para forzar reproceso de un fichero**: borra esa entrada del JSON, o el fichero entero.

## Qué hace si Graph falla puntualmente

| Operación | Comportamiento |
|---|---|
| `descargar_meteo_inbox` | 3 reintentos con backoff. Si todos fallan, el ciclo **continúa con lo que hubiese en INBOX local**. El siguiente cron lo reintenta. |
| `subir_resultados` | 3 reintentos por fichero. Los que fallan van al log Python pero no abortan los demás. |
| `subir_log_a_sharepoint` | 3 reintentos. Si fallan, el log local queda intacto y el siguiente ciclo lo sobreescribe en SharePoint cuando funcione. |

## Convivencia con OneDrive

OneDrive **no estorba**: si sigue sincronizando, los ficheros locales aparecen también en la nube. Es solo que **ya no es la fuente de verdad** para la entrega — esa pasa a ser Graph. Puedes desinstalar OneDrive del PC sin romper nada.

## Rollback

Si necesitas volver a la versión OneDrive:
- Restaura tu `main.py` y `sharepoint.py` originales.
- El bloque `graph:` en `config.yaml` puede quedarse — no estorba (queda ignorado).
- La env var `PVSYST1_EPI_SECRET` tampoco estorba.

## Notas sutiles

1. **No más `forzar_sincronizacion`**: los tres sleeps de 10–15 s que tenías han desaparecido. El ciclo es bastante más rápido.

2. **`subir_resultados` cambia de firma**: antes `(ficheros, raiz_sharepoint, base_url)`, ahora `(ficheros, cfg)`. El cfg trae lo necesario.

3. **El estado de meteos se actualiza al BAJAR el fichero**, no al terminar la simulación. Decisión deliberada: si la simulación falla, no entrar en bucle reintentando el mismo input. Para forzar reintento, borra la entrada del JSON.

4. **Los logs diarios se sobreescriben en SharePoint** al final de cada ciclo con la versión local más reciente. Si el cron corre N veces al día, la versión final en SharePoint es la última subida.
