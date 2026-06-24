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
