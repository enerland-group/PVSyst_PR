"""
Orquestador de la automatización PVsyst CLI.

Cambios vs. versión OneDrive:
  - Al inicio se hace PULL del meteo desde SharePoint via Graph (no depende de sync OneDrive).
  - Al final se hace PUSH de resultados Y logs via Graph (no depende de sync OneDrive).

Incluye Log de Rescate: si el .bat no escribe nada, Python crea el log.
"""
from __future__ import annotations

import datetime as dt
import logging
import re
import sys
import time
import tempfile
import shutil
from pathlib import Path

import yaml

from runner import ejecutar_bat
from sharepoint import (
    descargar_meteo_inbox,
    marcar_meteos_procesados,
    borrar_meteo_inbox,
    subir_resultados,
    subir_log_a_sharepoint,
)
from fabric_jobs import lanzar_pipeline_pr
from notifier import enviar_resumen_breve

# ---------- Logging ----------
def configurar_logging():
    # Forzar UTF-8 en stdout/stderr para que los emojis (✅ ⚠️ ❌ 📥 🗑️ ⏳) no
    # rompan en consolas cp1252/cp65001. Disponible desde Python 3.7.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )

logger = logging.getLogger(__name__)

# ---------- Configuración ----------
def cargar_config(ruta: str = "config.yaml") -> dict:
    with open(ruta, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)

# ---------- Gestión de Logs y SharePoint ----------
def forzar_sincronizacion(mensaje: str, segundos: int = 15):
    logger.info(f"⏳ {mensaje} (esperando {segundos} segundos)...")
    time.sleep(segundos)

def _buscar_log_reciente(carpeta_logs: str, prefijo: str) -> Path | None:
    p = Path(carpeta_logs)
    if not p.is_dir(): return None
    candidatos = sorted(
        (f for f in p.iterdir() if f.is_file() and f.name.startswith(prefijo)),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )
    return candidatos[0] if candidatos else None

def acumular_log_pvsyst(cfg: dict, planta: str, tipo_bat: str, exito: bool, consola_python: str, archivo_log_dia: Path):
    """Appendea el log del .bat al fichero único del día en LOGS.

    Si el .bat no generó log, usa la consola capturada por Python como rescate.

    Nota: aquí solo escribimos LOCAL. La subida a SharePoint via Graph se hace
    al final del ciclo (una sola vez por log/día) — ver subir_logs_del_dia().
    """
    archivo_log_dia.parent.mkdir(parents=True, exist_ok=True)

    estado = "OK" if exito else "ERROR"
    cabecera = (
        f"\n{'='*60}\n"
        f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {estado} - {planta} - {tipo_bat}\n"
        f"{'='*60}\n"
    )

    log_origen = _buscar_log_reciente(cfg["paths"]["bat_logs"], tipo_bat)

    if log_origen and log_origen.exists():
        try:
            contenido = log_origen.read_text(encoding="cp1252", errors="replace")
        except Exception as e:
            contenido = f"[Error leyendo log del .bat: {e}]"
    else:
        logger.warning("⚠️ No se encontró el log del .bat. Usando consola Python como rescate.")
        contenido = f"--- LOG GENERADO POR PYTHON (el .bat no arrancó) ---\n{consola_python}"

    try:
        with open(archivo_log_dia, "a", encoding="utf-8") as fh:
            fh.write(cabecera)
            fh.write(contenido)
            if not contenido.endswith("\n"):
                fh.write("\n")
        logger.info(f"✅ Log acumulado en {archivo_log_dia.name} ({estado} - {planta})")
    except Exception as e:
        logger.error(f"❌ Error escribiendo log acumulado: {e}")

def limpiar_log_central(cfg: dict, tipo_bat: str):
    log_central = _buscar_log_reciente(cfg["paths"]["bat_logs"], tipo_bat)
    if log_central and log_central.exists():
        try: log_central.unlink()
        except: pass

def rotar_logs(carpeta_logs: Path, prefijo: str, max_archivos: int = 30):
    """Mantiene como mucho max_archivos con ese prefijo, borrando los más antiguos."""
    if not carpeta_logs.is_dir():
        return
    archivos = sorted(
        (f for f in carpeta_logs.iterdir() if f.is_file() and f.name.startswith(prefijo)),
        key=lambda f: f.stat().st_mtime,
    )
    excedente = len(archivos) - max_archivos
    for f in archivos[:max(0, excedente)]:
        try:
            f.unlink()
            logger.info(f"🗑️ Log antiguo borrado: {f.name}")
        except Exception as e:
            logger.warning(f"No se pudo borrar {f.name}: {e}")

def subir_logs_del_dia(cfg: dict, fecha_dia: str, *paths_locales: Path):
    """Tras un ciclo, sube los logs locales del día a SharePoint via Graph.
    Sobreescribe si ya existían (replace semantics)."""
    for p in paths_locales:
        if p.exists():
            tipo = "alta" if "alta" in p.name else "run"
            subir_log_a_sharepoint(p, cfg, fecha_dia, tipo)

# ---------- Procesamiento Aislado ----------
EXT_POR_PLANTA = {".sit", ".mef", ".met", ".sfi"}
EXT_GENERICAS = {".pan", ".ond"}
EXT_REFERENCIAS = {".pdf", ".xlsx", ".xlsm", ".docx", ".txt", ".md"}
RE_VARIANTE = re.compile(r"^\.v..$", re.IGNORECASE)

def _debe_copiarse(f: Path, stem_target: str) -> bool:
    r"""Decide si un fichero del INBOX se copia al dir_temp de la planta `stem_target`.

    - Específicos de planta (SIT/MEF/MET/SFI): solo si el stem coincide exacto.
    - Variantes (.V??): nunca como acompañantes; se procesan en su propio turno.
    - Referencias (PDF/XLSX/DOCX/TXT/MD): solo si su nombre contiene el stem.
      El bat las mueve directamente a <SharePoint>\<Planta>\reference\.
    - Genéricos (PAN/OND): siempre.
    """
    ext = f.suffix.lower()
    if RE_VARIANTE.match(ext):
        return False
    if ext in EXT_POR_PLANTA:
        return f.stem == stem_target
    if ext in EXT_REFERENCIAS:
        return stem_target.lower() in f.stem.lower()
    if ext in EXT_GENERICAS:
        return True
    return False

def ejecutar_aislado(fichero_principal: Path, inbox: Path, script_bat: str, timeout: int | None) -> tuple[bool, str, list[str]]:
    archivos_copiados = []
    stem_target = fichero_principal.stem

    if not fichero_principal.exists():
        msg = f"El fichero principal ya no existe en disco: {fichero_principal}"
        logger.error(f"❌ {msg}")
        return False, msg, []

    with tempfile.TemporaryDirectory() as tmpdir:
        dir_temp = Path(tmpdir)
        try:
            shutil.copy2(str(fichero_principal), str(dir_temp / fichero_principal.name))
        except FileNotFoundError as e:
            msg = f"No se pudo copiar {fichero_principal.name}: {e}"
            logger.error(f"❌ {msg}")
            return False, msg, []
        archivos_copiados.append(fichero_principal.name)

        for f in inbox.iterdir():
            if not f.is_file() or f.name == fichero_principal.name:
                continue
            if not _debe_copiarse(f, stem_target):
                continue
            try:
                shutil.copy2(str(f), str(dir_temp / f.name))
                archivos_copiados.append(f.name)
            except FileNotFoundError:
                logger.warning(f"⚠️ {f.name} desapareció durante la copia, se ignora")

        res = ejecutar_bat(f'{script_bat} "{dir_temp}"', timeout=timeout)
        consumidos = [nom for nom in archivos_copiados if not (dir_temp / nom).exists()]
        return res.ok, res.consola_completa, consumidos

def categorizar(archivos):
    cats = {"prj": [], "variant": [], "csv": [], "otros": []}
    for f in archivos:
        ext = f.suffix.lower()
        if ext == ".prj": cats["prj"].append(f)
        elif RE_VARIANTE.match(ext): cats["variant"].append(f)
        elif ext == ".csv": cats["csv"].append(f)
        else: cats["otros"].append(f)
    return cats

_RE_PROCESANDO = re.compile(r"^\[~\] Procesando archivo \d+: (.+?)\s*$", re.MULTILINE)

def _segmento_log_csv(log_contenido: str, csv_name: str) -> str:
    """Recorta log_contenido al tramo que corresponde a csv_name.

    auto_run.bat procesa TODOS los CSV del ciclo en una sola llamada y lo
    vuelca todo al mismo log central (ver auto_run.bat linea 11), delimitando
    cada CSV con "[~] Procesando archivo N: <nombre>". Sin este recorte, una
    frase de OTRA planta del mismo lote -- p.ej. "aggregate_by_hour=true" de
    una planta que sí lo tiene marcado a proposito en T01_plants -- contaminaba
    el modo detectado para esta (siempre mostraba "horaria" aunque hubiese
    corrido en subhorario/pseudo-subhorario). Si no se encuentra el delimitador
    (log antiguo, formato distinto...) se devuelve el log entero tal cual, que
    es el comportamiento de siempre.
    """
    marcas = list(_RE_PROCESANDO.finditer(log_contenido))
    for i, m in enumerate(marcas):
        if m.group(1).strip() == csv_name:
            inicio = m.end()
            fin = marcas[i + 1].start() if i + 1 < len(marcas) else len(log_contenido)
            return log_contenido[inicio:fin]
    return log_contenido

def buscar_ficheros_generados(carpeta_proyectos, momento_inicio):
    """Devuelve lista de tuples (planta, subdir_destino, fichero) con los resultados
    PVsyst y las referencias producidos/movidos en este ciclo.

    Recorre:
      - projects/<Planta>/results_out/  → subdir "" (van bajo <Planta>/ en SharePoint)
      - projects/<Planta>/reference/    → subdir "reference"
    Filtra por mtime >= momento_inicio para no re-subir ficheros antiguos.
    """
    raiz = Path(carpeta_proyectos)
    ts = momento_inicio.timestamp()
    res = []

    EXTS_RESULTS = (".csv", ".pdf", ".txt")
    EXTS_REFS    = (".pdf", ".xlsx", ".xlsm", ".docx", ".txt", ".md")

    for p_dir in raiz.iterdir():
        if not p_dir.is_dir():
            continue

        # 1) results_out → resultados del PVsyst CLI (CSV/PDF/TXT)
        res_dir = p_dir / "results_out"
        if res_dir.is_dir():
            for f in res_dir.iterdir():
                if f.is_file() and f.suffix.lower() in EXTS_RESULTS and f.stat().st_mtime >= ts:
                    res.append((p_dir.name, "", f))

        # 2) reference → documentos subidos en una alta (PDF/XLSX/DOCX/etc.)
        ref_dir = p_dir / "reference"
        if ref_dir.is_dir():
            for f in ref_dir.iterdir():
                if f.is_file() and f.suffix.lower() in EXTS_REFS and f.stat().st_mtime >= ts:
                    res.append((p_dir.name, "reference", f))

    return sorted(res, key=lambda t: (t[0], t[1], t[2].name))

# ---------- Bucle Principal ----------
def main() -> int:
    cfg = cargar_config()
    configurar_logging()

    momento_inicio = dt.datetime.now()
    inbox = Path(cfg["paths"]["inbox"])
    inbox.mkdir(parents=True, exist_ok=True)

    sp_logs_dir = Path(cfg["paths"]["sharepoint_logs"])
    fecha_dia = momento_inicio.strftime("%Y%m%d")
    log_alta_dia = sp_logs_dir / f"log_alta_{fecha_dia}.txt"
    log_run_dia = sp_logs_dir / f"log_run_{fecha_dia}.txt"

    # === 1. Pull de meteo desde SharePoint via Graph (NUEVO) ===
    descargados: list[Path] = []
    pending_meteos: dict = {}        # se persiste en JSON SOLO al final si hubo_fallos=False
    try:
        descargados, pending_meteos = descargar_meteo_inbox(cfg, inbox)
        if descargados:
            logger.info(f"[Graph] Descargados {len(descargados)} fichero(s) nuevo(s) desde SharePoint:")
            for p in descargados:
                logger.info(f"   - {p.name}")
    except Exception as e:
        logger.error(f"[Graph] Fallo en pull de meteo: {e}")
        # No abortamos: si hay algo en INBOX local de runs anteriores, podemos seguir.

    logger.info(f"Buscando en: {inbox}")

    entradas: list[Path] = []
    descargados_set = {p.resolve() for p in descargados}

    # 1) Los recién bajados via Graph: se procesan sin esperar (la descarga es atómica)
    for f in descargados:
        if f.is_file():
            entradas.append(f)

    # 2) Lo que ya hubiese en INBOX y NO acabamos de descargar: solo si tiene >30s
    #    (residuos de runs anteriores o drops manuales del usuario)
    if inbox.is_dir():
        for f in inbox.iterdir():
            if not f.is_file() or f.name.startswith("~$"):
                continue
            if f.resolve() in descargados_set:
                continue
            if (dt.datetime.now().timestamp() - f.stat().st_mtime) > 30:
                entradas.append(f)

    if not entradas:
        logger.info("Nada nuevo en el Inbox.")
        return 0

    cats = categorizar(entradas)
    webhook = cfg["teams"]["webhook_url"]
    timeout = cfg["bats"].get("timeout_segundos")
    hubo_fallos = False
    eventos = []

    # Conjunto de NOMBRES de fichero (no rutas) que se procesaron correctamente.
    # Solo estos se marcarán en state.json y se borrarán de SharePoint /inbox/.
    # Los que NO estén aquí se reintentarán en el próximo ciclo.
    procesados_ok: set[str] = set()
    plantas_run: dict[str, bool] = {}   # planta -> ok (simulaciones CSV); ámbito de función para el lanzamiento del pipeline PR

    logger.info(f"Categorización: {len(cats['prj'])} alta(s), {len(cats['variant'])} variante(s), {len(cats['csv'])} CSV(s).")

    # 2. ALTAS
    for prj in cats["prj"]:
        planta = prj.stem
        logger.info(f"[auto_alta] Ejecutando para planta {planta} (sin output hasta que termine)...")
        ok, consola, consumidos = ejecutar_aislado(prj, inbox, cfg["bats"]["auto_alta"], timeout)
        logger.info(f"[auto_alta] {planta} terminado: {'OK' if ok else 'FALLO'}")
        acumular_log_pvsyst(cfg, planta, "auto_alta", ok, consola, log_alta_dia)

        if ok:
            eventos.append({"ok": True, "prefijo": "Alta planta", "planta": planta})
            for nom in consumidos:
                try: (inbox / nom).unlink()
                except: pass
                procesados_ok.add(nom)
        else:
            eventos.append({"ok": False, "prefijo": "Error alta planta", "planta": planta})
            hubo_fallos = True

    limpiar_log_central(cfg, "auto_alta")

    # 3. VARIANTES
    for var in cats["variant"]:
        planta = var.stem
        logger.info(f"[auto_alta variante] Ejecutando para planta {planta} (variante {var.suffix})...")
        ok, consola, consumidos = ejecutar_aislado(var, inbox, cfg["bats"]["auto_alta"], timeout)
        logger.info(f"[auto_alta variante] {planta} terminado: {'OK' if ok else 'FALLO'}")
        acumular_log_pvsyst(cfg, planta, "auto_alta", ok, consola, log_alta_dia)

        if ok:
            eventos.append({"ok": True, "prefijo": "Cambio de variante en planta", "planta": planta})
            for nom in consumidos:
                try: (inbox / nom).unlink()
                except: pass
                procesados_ok.add(nom)
        else:
            eventos.append({"ok": False, "prefijo": "Error cambio de variante en planta", "planta": planta})
            hubo_fallos = True

    limpiar_log_central(cfg, "auto_alta")

    # 4. SIMULACIONES (CSV)
    if cats["csv"]:
        csv_names = [c.name for c in cats["csv"]]
        logger.info(f"[auto_run] Ejecutando para {len(csv_names)} CSV: {csv_names}")
        logger.info(f"[auto_run] Esto puede tardar varios minutos. SIN output intermedio hasta que termine.")
        logger.info(f"[auto_run] Si timeout={timeout}s configurado, se cortará al expirar.")
        res_run = ejecutar_bat(f'{cfg["bats"]["auto_run"]} "{inbox}"', timeout=timeout)
        logger.info(f"[auto_run] Terminado: exit_code={res_run.exit_code} timed_out={res_run.timed_out}")
        consola_run = res_run.consola_completa

        # auto_run.bat redirige toda su salida a su log central, así que consola_run
        # llega vacío. Leemos el log para saber qué CSV salió bien y cuál no.
        log_run_central = _buscar_log_reciente(cfg["paths"]["bat_logs"], "auto_run")
        log_contenido = ""
        if log_run_central and log_run_central.exists():
            try:
                log_contenido = log_run_central.read_text(encoding="cp1252", errors="replace")
            except Exception as e:
                logger.error(f"❌ No se pudo leer el log de auto_run: {e}")

        for csv_f in cats["csv"]:
            planta = csv_f.name.split('_')[0] if '_' in csv_f.name else csv_f.stem
            ok_csv = f"[ OK ] {csv_f.name}" in log_contenido

            # Acumulamos por planta: una planta es OK si todos sus CSV fueron OK.
            plantas_run[planta] = plantas_run.get(planta, True) and ok_csv

            if ok_csv:
                procesados_ok.add(csv_f.name)
                # Recortado al tramo de ESTE CSV (ver _segmento_log_csv): antes se
                # buscaba en el log del dia entero y una planta con
                # aggregate_by_hour=true en el mismo lote contaminaba el modo de
                # las demas (siempre salia "horaria").
                log_csv = _segmento_log_csv(log_contenido, csv_f.name)
                if "[PSEUDO-SUBHOUR OK]" in log_csv:
                    modo = "pseudo-cuartohoraria"
                elif "aggregate_by_hour=true" in log_csv or "PVsyst rechazo subhour" in log_csv:
                    modo = "horaria"
                else:
                    modo = "cuartohoraria"
                eventos.append({
                    "ok": True,
                    "prefijo": "Simulación diaria completa",
                    "planta": planta,
                    "sufijo": f" ({modo})",
                })
            else:
                eventos.append({
                    "ok": False,
                    "prefijo": "Error simulación diaria",
                    "planta": planta,
                })
                hubo_fallos = True

        # auto_run.bat se ejecuta UNA sola vez para todos los CSV, así que escribimos
        # el log también UNA sola vez (si llamáramos a acumular_log_pvsyst por planta,
        # leeríamos el mismo log central N veces y se duplicaría en el log del día).
        if plantas_run:
            plantas_listadas = ", ".join(sorted(plantas_run.keys()))
            ok_global = all(plantas_run.values())
            acumular_log_pvsyst(cfg, plantas_listadas, "auto_run", ok_global, consola_run, log_run_dia)

        limpiar_log_central(cfg, "auto_run")

    # === 5. Subir resultados a SharePoint via Graph (CAMBIADO) ===
    generados = buscar_ficheros_generados(cfg["paths"]["proyectos"], momento_inicio)
    subir_resultados(generados, cfg)

    # === 6. Subir logs del día via Graph (NUEVO) ===
    # Tras todo el ciclo, los logs locales están completos. Los subimos al final
    # para que SharePoint tenga la versión definitiva del día.
    subir_logs_del_dia(cfg, fecha_dia, log_alta_dia, log_run_dia)

    # 7. Rotación local: conservar como mucho 30 logs de cada tipo
    rotar_logs(sp_logs_dir, "log_alta_", 30)
    rotar_logs(sp_logs_dir, "log_run_", 30)

    # 8. Persistir el estado y limpiar SharePoint — POR FICHERO.
    #    Se marca/borra cada fichero que se procesó correctamente.
    #    Los que fallaron se quedan en SharePoint /inbox/ para reintentar en
    #    el siguiente ciclo, sin bloquear al resto.
    if pending_meteos:
        pending_ok = {n: d for n, d in pending_meteos.items() if n in procesados_ok}
        pending_fail = {n: d for n, d in pending_meteos.items() if n not in procesados_ok}

        if pending_ok:
            logger.info(f"Marcando como procesados {len(pending_ok)} fichero(s) correctos: {sorted(pending_ok.keys())}")
            marcar_meteos_procesados(pending_ok, cfg)
            borrar_meteo_inbox(cfg, list(pending_ok.keys()))

        if pending_fail:
            logger.warning(f"{len(pending_fail)} fichero(s) NO procesado(s) correctamente: {sorted(pending_fail.keys())}")
            logger.warning("  → se reintentarán en el próximo ciclo, NO se borran del SharePoint inbox.")

    # === 9. Lanzar el pipeline 2 (PR_calculation) en Fabric directamente ===
    # Sin Power Automate: llamamos a la Job Scheduler API de Fabric con la misma
    # app (PVSyst1_EPI). Solo pasamos plant_codes (plantas con simulación OK este
    # ciclo). NO pasamos fechas: csv_ingest ingesta el CSV entero y calculate_pr,
    # con periodo vacío, calcula sobre el rango completo disponible (idempotente
    # por run_id). traceability_export, con periodo vacío, usa num_months=3.
    plantas_sim_ok = sorted(p for p, ok in plantas_run.items() if ok)
    if plantas_sim_ok:
        try:
            lanzar_pipeline_pr(cfg, plantas_sim_ok)
        except Exception as e:
            logger.error(f"No se pudo lanzar el pipeline PR en Fabric: {e}")
    else:
        logger.info("No hay simulaciones OK este ciclo: no se lanza el pipeline PR.")

    # 10. Notificación Teams
    if eventos: enviar_resumen_breve(webhook, eventos, hubo_fallos)

    return 1 if hubo_fallos else 0

if __name__ == "__main__":
    sys.exit(main())
