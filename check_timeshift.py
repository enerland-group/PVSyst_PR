"""
Diagnostico de la franja horaria / time-shift de una planta.

Corre `convert-meteo` con TODOS los ficheros de produccion (CSV del inbox, MEF,
SIT) pero SIN pasarle `-imt`, de modo que PVsyst tenga que deducir el desfase
solo a partir de la configuracion. Luego valida el MET resultante con
`run-simulation` y extrae el desfase que PVsyst detecta.

Ademas MIDE donde cae la curva, sin depender de que PVsyst diga nada: compara el
CSV raw medido contra el resultado simulado y ambos contra el mediodia solar
astronomico del emplazamiento (lat/lon/TimeZone del SIT, con ecuacion del tiempo).
Para cada dia calcula el centro de masa de la irradiancia -- mas estable que el
maximo puntual, que se lo lleva cualquier nube -- y se queda con la mediana de
todos los dias. De ahi salen tres numeros:

    CSV raw medido     -> si el SCADA ya entrega los datos corridos (causa raiz)
    resultado simulado -> si lo que simula PVsyst esta CENTRADO (lo que importa)
    desplazamiento     -> cuanto ha movido la cadena, para contrastarlo con el
                          TimeShiftTotalMin de la variante

Esto pilla el caso malo de verdad: el CLI acepta el MET sin protestar y aun asi
el dia sale corrido.

El desfase de cada planta se declara en la tabla `T08_time_shifts` del Excel de
configuracion, en MINUTOS y sin limite de rango, con las fechas de los cambios de
hora. De ahi lo reparte `timeshift.py`: las horas enteras las resuelve PVsyst
solo (si la MEF tiene `UsesDST=True` + `RefTimeS=LegalTime` + `DateHEte`/
`DateHHiver` coherentes con la regla de la UE -- ver `es_dst_fiable()`) y el
resto va siempre al `-imt` del CLI, dentro de [-30;+30]. Solo si esos campos de
la MEF no son de fiar se cae al mecanismo antiguo de corregir las marcas de
tiempo del propio CSV raw. Asi que lo que se ajusta al iterar es la celda de T08.
El MEF ya no lo escribe nadie (solo se lee para UsesDST y para avisar de
residuos), y el `TimeShift` del fichero de variante no se usa.

Uso tipico (iterar hasta que el desfase caiga dentro de [-30;+30]):

    python check_timeshift.py FRA
    ...corregir time_shift de FRA en T08_time_shifts (segun lo que diga aqui)...
    python check_timeshift.py FRA        # repetir hasta OK

Opciones:
    --csv RUTA     usar un CSV concreto en vez del mas reciente del inbox
    --imt N        pasar -imt:N (para comprobar el valor final, no para el diagnostico)
    --no-sim       solo convert-meteo, sin validar con run-simulation
    --keep         no borrar el MET de prueba

Codigo de salida: 0 si todas las plantas quedan dentro de [-30;+30]; 1 si alguna
se sale o falla. Asi se puede usar en un bucle.

IMPORTANTE: no toca el MET de produccion. Escribe `<PLANTA>__TSCHECK.MET` dentro
de %WS%\\Meteo (el CLI ignora -omf si apunta fuera del workspace) y lo borra al
terminar salvo --keep.
"""
from __future__ import annotations

import argparse
import math
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter
from datetime import datetime, timedelta
from datetime import time as dtime
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None

# El formato del CSV raw (separador, columna y formato de la fecha, paso) lo lee
# timeshift.py, que es quien lo necesita en produccion para corregir las horas.
# Aqui se reutiliza tal cual para que el diagnostico interprete el CSV EXACTAMENTE
# igual que la conversion.
from timeshift import leer_formato_mef, parsear_fecha

# Valores por defecto: los mismos que tiene cableados auto_run.bat.
WS_DEFAULT  = r"C:\Users\PVSYST1\PVsyst8.1_Data"
CLI_DEFAULT = r"C:\Program Files\PVsyst8.1.4\PVsystCLI.exe"
IMT_MIN, IMT_MAX = -30, 30

SUFIJO_CHECK = "__TSCHECK"


# --------------------------------------------------------------------------
# Lectura de config y de ficheros PVsyst
# --------------------------------------------------------------------------
def cargar_config():
    """config.yaml del propio directorio del script. Devuelve {} si no hay."""
    ruta = Path(__file__).with_name("config.yaml")
    if yaml is None or not ruta.exists():
        return {}
    with open(ruta, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def leer_campo(ruta: Path, clave: str):
    """Ultimo valor de `clave=` en un fichero PVsyst (SIT/MEF/MET/variante).

    Exige el '=' pegado al nombre, igual que el findstr de auto_run.bat, para que
    'TimeShift' no capture 'TimeShiftTotalMin' ni 'HourShift' capture 'HourShiftF'.
    """
    if not ruta.exists():
        return None
    patron = re.compile(r"^\s*" + re.escape(clave) + r"=(.*)$")
    valor = None
    with open(ruta, "r", encoding="cp1252", errors="replace") as f:
        for linea in f:
            m = patron.match(linea.rstrip("\r\n"))
            if m:
                valor = m.group(1).strip()
    return valor


def como_entero(v):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def leer_variante(var_txt: Path):
    """Codigo de la variante activa desde projects\\<PLANTA>\\variant.txt.

    Es la unica fuente de verdad: la escribe auto_alta.bat y la lee auto_run.bat
    con `SET /P`. Se tolera lo que un editor puede haber dejado dentro: BOM,
    comillas, lineas en blanco delante, espacios al final. Devuelve None si no
    hay nada aprovechable.
    """
    if not var_txt.exists():
        return None
    datos = var_txt.read_bytes()
    for enc in ("utf-8-sig", "cp1252"):
        try:
            texto = datos.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        texto = datos.decode("cp1252", errors="replace")
    for linea in texto.splitlines():
        v = linea.strip().strip('"').strip("﻿").strip()
        if v:
            return v
    return None


# --------------------------------------------------------------------------
# Llamadas al CLI
# --------------------------------------------------------------------------
LATIDO_SEG = 30


def ejecutar(cmd, timeout, prefijo="     | "):
    """Lanza el CLI y devuelve (returncode, salida_combinada).

    La salida se imprime EN VIVO segun llega. El `convert-meteo` puede tardar
    minutos y el `run-simulation` bastante mas; sin esto el script pasa todo ese
    rato mudo y no hay forma de distinguirlo de un cuelgue. Ademas hay un latido
    cada LATIDO_SEG segundos por si el CLI no escribe nada durante un buen rato.

    stdin va a DEVNULL a proposito: si el CLI pidiera confirmacion por consola,
    con stdin heredado se quedaria esperando una tecla que nadie va a pulsar (y
    el prompt ni se veria, va capturado) hasta agotar el timeout entero. Cerrado,
    falla en el acto.
    """
    try:
        p = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="cp1252",
            errors="replace",
            bufsize=1,
        )
    except FileNotFoundError:
        return -1, f"[ERROR] no se encuentra el ejecutable: {cmd[0]}"

    lineas = []
    t0 = time.monotonic()
    fin = threading.Event()
    matado = threading.Event()

    def vigilante():
        while not fin.wait(LATIDO_SEG):
            transcurrido = time.monotonic() - t0
            if transcurrido > timeout:
                matado.set()
                p.kill()
                return
            print(f"     ... {int(transcurrido)} s en marcha (limite {timeout} s)",
                  flush=True)

    hilo = threading.Thread(target=vigilante, daemon=True)
    hilo.start()
    try:
        for linea in p.stdout:
            linea = linea.rstrip("\r\n")
            lineas.append(linea)
            if linea.strip():
                print(f"{prefijo}{linea}", flush=True)
        p.wait()
    finally:
        fin.set()
        hilo.join(timeout=1)
        if p.stdout:
            p.stdout.close()

    if matado.is_set():
        aviso = f"[TIMEOUT] el CLI no respondio en {timeout} s; proceso matado"
        print(f"     {aviso}", flush=True)
        return -1, "\n".join(lineas + [aviso])
    return p.returncode, "\n".join(lineas)


RE_DETECTADO = re.compile(r"time shift detected is\s*([+-]?\d+)\s*minute", re.IGNORECASE)
RE_RANGO     = re.compile(r"(not in|out of range|between)\D{0,20}30|\[-?30", re.IGNORECASE)


def desfase_detectado(salida: str):
    m = RE_DETECTADO.search(salida)
    return int(m.group(1)) if m else None


# --------------------------------------------------------------------------
# Analisis de curvas: donde cae el pico y si esta centrado
# --------------------------------------------------------------------------
# Tolerancia del veredicto de centrado, en minutos. Se usa el mismo +-30 que
# admite el -imt: por debajo de eso el residuo se corrige con -imt y por encima
# hay que tocar la hora entera (TimeZone del SIT / HourShiftF de la MEF).
TOL_CENTRADO = 30

# Un dia con menos muestras diurnas que esto no da un centroide fiable.
MIN_MUESTRAS_DIA = 6

# Fraccion del maximo diario por debajo de la cual la muestra se considera
# noche/ruido y no entra en el centroide.
UMBRAL_DIA = 0.05


def _a_float(txt: str):
    """Numero de un CSV que puede venir con coma decimal (locale ES)."""
    txt = (txt or "").strip().replace(",", ".")
    try:
        return float(txt)
    except ValueError:
        return None


def leer_serie_raw(csv: Path, fmt):
    """[(instante, GHI)] del CSV crudo medido, segun el formato de la MEF."""
    if "GlobHor" not in fmt["variables"]:
        return [], "la MEF no declara ninguna variable GlobHor"
    col_ghi, factor = fmt["variables"]["GlobHor"]
    sep, col_fecha = fmt["separador"], fmt["campo_fecha"]
    serie, malas = [], 0
    with open(csv, "r", encoding="cp1252", errors="replace") as f:
        for n, linea in enumerate(f, start=1):
            if n <= fmt["cabecera"]:
                continue
            trozos = linea.rstrip("\r\n").split(sep)
            if len(trozos) < max(col_fecha, col_ghi):
                continue
            t = parsear_fecha(trozos[col_fecha - 1], fmt["orden_fecha"])
            v = _a_float(trozos[col_ghi - 1])
            if t is None or v is None:
                malas += 1
                continue
            serie.append((t, v * factor))
    aviso = f"{malas} lineas del CSV raw no se han podido leer" if malas else None
    return serie, aviso


def leer_serie_resultado(out_csv: Path, columna="GlobHor"):
    """[(instante, valor)] del CSV de resultados de PVsyst.

    Formato: bloque de cabecera, luego la fila de nombres que empieza por 'date',
    una fila de unidades, y los datos separados por ';'. Con sep=';' una coma solo
    puede ser separador decimal (8.1.4 exporta en locale ES).
    """
    lineas = out_csv.read_text(encoding="cp1252", errors="replace").splitlines()
    idx = next((i for i, l in enumerate(lineas)
                if l.lower().lstrip("﻿").startswith("date;")), None)
    if idx is None:
        return [], "el CSV de resultados no tiene fila de cabecera 'date;...'"
    nombres = [c.strip().lstrip("﻿") for c in lineas[idx].split(";")]
    if columna not in nombres:
        return [], f"el CSV de resultados no trae la columna {columna} ({', '.join(nombres[1:])})"
    col = nombres.index(columna)

    serie = []
    for linea in lineas[idx + 1:]:
        trozos = linea.rstrip("\r\n").split(";")
        if len(trozos) <= col:
            continue
        t = parsear_fecha(trozos[0], "DDxMMxYYxhhxmm")
        v = _a_float(trozos[col])
        if t is not None and v is not None:
            serie.append((t, v))
    return serie, None


def paso_de_serie(serie):
    """Paso de muestreo en minutos: la diferencia mas frecuente entre marcas."""
    if len(serie) < 3:
        return None
    difs = Counter(int((b[0] - a[0]).total_seconds() // 60)
                   for a, b in zip(serie, serie[1:]))
    difs.pop(0, None)
    return difs.most_common(1)[0][0] if difs else None


def etiqueta_al_final(serie, paso):
    """True si la marca de tiempo etiqueta el FIN del intervalo, no el principio.

    El CSV del SCADA empieza el dia en 00:15 (el intervalo 00:00-00:15 etiquetado
    al final) mientras que PVsyst escribe 00:00 (etiquetado al principio). Sin
    corregirlo, comparar los dos centroides mete un sesgo sistematico de medio
    paso de cada serie y el desfase medido sale falseado.

    Solo se puede saber por el PRIMER instante del fichero: el conjunto de horas
    del dia es identico en los dos convenios (una serie etiquetada al final trae
    igualmente un 00:00, que es el ultimo intervalo del dia anterior), asi que
    mirar las horas presentes no distingue nada. Con la serie empezando a mitad
    de un dia no hay senal fiable: se asume el convenio de PVsyst (al principio),
    que es el caso que importa no estropear.
    """
    if not serie or not paso:
        return False
    return (serie[0][0].hour * 60 + serie[0][0].minute) == paso


def centro_de_masa(serie, paso=None, al_final=None):
    """Hora del 'centro de gravedad' de la curva diaria, por dia.

    Pondera cada muestra por su irradiancia, asi que devuelve donde esta el centro
    de la campana sin depender de que el maximo puntual caiga en una nube. Se
    descarta la noche (por debajo de UMBRAL_DIA del maximo del dia).

    `al_final` fuerza el convenio de etiquetado; si es None se deduce de la serie.
    Conviene decidirlo UNA vez sobre la serie original: se deduce del primer
    instante, asi que recalcularlo sobre una serie ya desplazada da otro resultado
    y mete medio paso de error.

    Devuelve {fecha: hora_decimal}.
    """
    if paso is None:
        paso = paso_de_serie(serie)
    if al_final is None:
        al_final = etiqueta_al_final(serie, paso)
    # Llevar la marca al centro fisico del intervalo que representa.
    ajuste = -(paso or 0) / 2.0 if al_final else (paso or 0) / 2.0

    por_dia = {}
    for t, v in serie:
        t_centro = t + timedelta(minutes=ajuste)
        por_dia.setdefault(t_centro.date(), []).append((t_centro, v))

    centros = {}
    for dia, muestras in por_dia.items():
        pico = max(v for _, v in muestras)
        if pico <= 0:
            continue
        utiles = [(t, v) for t, v in muestras if v >= pico * UMBRAL_DIA]
        if len(utiles) < MIN_MUESTRAS_DIA:
            continue
        peso = sum(v for _, v in utiles)
        if peso <= 0:
            continue
        # Las horas se cuentan sobre el dia del centroide para que una muestra
        # que cruce medianoche no arrastre el resultado.
        centros[dia] = sum(
            ((t - datetime.combine(dia, dtime())).total_seconds() / 3600.0) * v
            for t, v in utiles) / peso
    return centros


def ecuacion_del_tiempo(fecha):
    """Ecuacion del tiempo en minutos (aproximacion NOAA, +-0,5 min).

    Hace falta: llega a +-16 min, y con una tolerancia de 30 min ignorarla seria
    gastarse media tolerancia en un error conocido.
    """
    n = fecha.timetuple().tm_yday
    b = 2 * math.pi * (n - 81) / 364.0
    return 9.87 * math.sin(2 * b) - 7.53 * math.cos(b) - 1.5 * math.sin(b)


def mediodia_solar(fecha, lon, tz):
    """Hora de reloj (escala del MET) a la que el sol culmina, en horas decimales."""
    return 12.0 - lon / 15.0 + tz - ecuacion_del_tiempo(fecha) / 60.0


def mediana(valores):
    v = sorted(valores)
    n = len(v)
    if not n:
        return None
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2.0


def _resumen_desfase(centros, lon, tz):
    """(mediana, dispersion, n_dias) del desfase contra el mediodia solar, en min."""
    difs = [(hora - mediodia_solar(dia, lon, tz)) * 60.0 for dia, hora in centros.items()]
    if not difs:
        return None, None, 0
    med = mediana(difs)
    return med, mediana([abs(d - med) for d in difs]), len(difs)


def analizar_curvas(serie_raw, serie_sim, lon, tz, total_t08=None):
    """Compara donde cae la curva medida y la simulada. Devuelve (ok, desfase_sim).

    Tres medidas, porque responden a preguntas distintas:
      - raw vs mediodia solar : si el CSV del SCADA ya viene desplazado (causa raiz)
      - resultado vs mediodia : si lo que simula PVsyst esta CENTRADO (lo que importa)
      - resultado vs raw      : cuanto ha movido la cadena, para contrastarlo con el
                                desfase que declara T08 y con el TimeShiftTotalMin
                                que estampa PVsyst
    ok es None cuando no hay datos suficientes para juzgar.
    """
    print()
    print("  --- Centrado de las curvas (centro de masa de la irradiancia) ---")
    if lon is None or tz is None:
        print("  [aviso] sin Longitude/TimeZone en el SIT no se puede situar el mediodia solar")
        return None, None

    c_raw = centro_de_masa(serie_raw) if serie_raw else {}
    c_sim = centro_de_masa(serie_sim) if serie_sim else {}
    if not c_raw and not c_sim:
        print("  [aviso] no hay dias con irradiancia suficiente para medir el centrado")
        return None, None

    for etiqueta, centros in (("CSV raw medido", c_raw), ("resultado simulado", c_sim)):
        if not centros:
            continue
        med, disp, n = _resumen_desfase(centros, lon, tz)
        hora = mediana(list(centros.values()))
        h, m = int(hora), int(round((hora % 1) * 60))
        print(f"  {etiqueta:<19}: pico medio {h:02d}:{m:02d}  ->  {med:+.0f} min "
              f"respecto al mediodia solar   (n={n} dias, dispersion +-{disp:.0f} min)")

    # Cuanto ha movido la cadena de conversion, dia a dia y solo con dias comunes.
    comunes = sorted(set(c_raw) & set(c_sim))
    if comunes:
        aplicado = mediana([(c_sim[d] - c_raw[d]) * 60.0 for d in comunes])
        print(f"  {'desplazamiento':<19}: la cadena ha movido la curva {aplicado:+.0f} min "
              f"respecto al raw   (n={len(comunes)} dias)")

    # El veredicto va sobre el resultado si lo hay; si no, sobre el raw.
    sobre_sim = bool(c_sim)
    med, disp, n = _resumen_desfase(c_sim if sobre_sim else c_raw, lon, tz)
    quien = "el resultado simulado" if sobre_sim else "el CSV raw (sin simular)"
    print()
    if disp is not None and disp > 45:
        print(f"  [aviso] dispersion alta (+-{disp:.0f} min): dias muy nublados falsean el")
        print( "          centro de masa. Repite con un tramo de dias despejados.")
    if abs(med) <= TOL_CENTRADO:
        print(f"  [OK] {quien} esta CENTRADO: {med:+.0f} min del mediodia solar,")
        print(f"       dentro de +-{TOL_CENTRADO} min. No hace falta anadir desfase.")
        return True, med
    print(f"  [FAIL] {quien} esta DESCENTRADO: {med:+.0f} min del mediodia solar.")
    print(f"         Conviene anadir un desfase de {-med:+.0f} min.")
    # explicar() habla en la misma convencion que el desfase que reporta PVsyst
    # (positivo = curva retrasada), que es justo lo que mide `med`.
    explicar(int(round(med)), tz, total_t08)
    return False, med


# --------------------------------------------------------------------------
# Diagnostico de una planta
# --------------------------------------------------------------------------
def diagnosticar(planta, ws, cli, inbox, proyectos, args):
    print("=" * 70)
    print(f"  {planta}")
    print("=" * 70)

    sit  = ws / "Sites"  / f"{planta}.SIT"
    mef  = ws / "Meteo"  / f"{planta}.MEF"
    prj  = ws / "Projects" / f"{planta}.PRJ"
    sfi  = ws / "Models" / f"{planta}.SFI"
    var_txt = proyectos / planta / "variant.txt"

    faltan = [str(p) for p in (sit, mef, prj) if not p.exists()]
    if faltan:
        print("  [ERROR] faltan ficheros de la planta:")
        for p in faltan:
            print(f"          {p}")
        return False

    # --- CSV de entrada ---
    if args.csv:
        csv = Path(args.csv)
        if not csv.exists():
            print(f"  [ERROR] no existe el CSV indicado: {csv}")
            return False
    else:
        candidatos = sorted(inbox.glob(f"{planta}_*.csv"),
                            key=lambda f: f.stat().st_mtime, reverse=True)
        if not candidatos:
            print(f"  [ERROR] no hay CSV de {planta} en {inbox}")
            print( "          auto_run.bat borra cada CSV al procesarlo, asi que lo normal")
            print( "          es que el inbox este vacio fuera del ciclo diario. Bajate uno")
            print( "          del SharePoint /inbox/ y pasalo con --csv RUTA.")
            return False
        csv = candidatos[0]
        if len(candidatos) > 1:
            print(f"  [aviso] {len(candidatos)} CSV de {planta} en el inbox; se usa el mas reciente")

    # --- variante activa: projects\<PLANTA>\variant.txt manda ---
    variante = leer_variante(var_txt)
    etiqueta_variante = variante or ("vacio" if var_txt.exists() else "sin variant.txt")
    var_file = ws / "Projects" / f"{planta}.{variante}" if variante else None
    problema_variante = None
    if variante is None:
        problema_variante = (f"variant.txt sin contenido aprovechable: {var_txt}"
                             if var_txt.exists() else f"falta {var_txt}")
    elif not var_file.exists():
        problema_variante = f"variant.txt dice '{variante}' pero no existe {var_file}"
    if problema_variante:
        variante = None
        var_file = None

    # --- configuracion declarada ---
    tz      = leer_campo(sit, "TimeZone")
    lat     = leer_campo(sit, "Latitude")
    lon     = leer_campo(sit, "Longitude")
    hshiftf = leer_campo(mef, "HourShiftF")
    tshiftf = leer_campo(mef, "TimeShiftF")
    paso    = leer_campo(mef, "MeasureStep")
    usesdst = leer_campo(mef, "UsesDST")
    reftime = leer_campo(mef, "RefTimeS")

    v_hshift = leer_campo(var_file, "HourShift")         if var_file else None
    v_tshift = leer_campo(var_file, "TimeShift")         if var_file else None
    v_total  = leer_campo(var_file, "TimeShiftTotalMin") if var_file else None

    # Desfase declarado en T08_time_shifts: es la fuente de verdad. De ahi salen
    # las horas (que timeshift.py corrige en las fechas del CSV raw) y los minutos
    # sueltos (que van al -imt). Si no se puede leer, el diagnostico sigue: solo se
    # pierde el contraste entre lo declarado y lo medido.
    total_t08 = None
    detalle_t08 = "no se ha podido leer"
    avisos_t08 = []
    try:
        import timeshift as tshift_mod
        xlsx, procedencia = tshift_mod.localizar_excel(cargar_config())
        reglas_t08 = tshift_mod.leer_reglas(xlsx).get(planta, [])
        _, _fin_csv = tshift_mod.rango_de_nombre(csv.name)
        total_t08 = tshift_mod.shift_en(reglas_t08, _fin_csv or datetime.now().date())
        h_t08, resto_t08 = tshift_mod.descomponer(total_t08)
        fechas_t08 = sorted({f for r in reglas_t08 for f in r.fechas()})
        detalle_t08 = (f"{total_t08:+d} min = {h_t08:+d} h (en el CSV, fechas "
                       f"{', '.join(f.isoformat() for f in fechas_t08) or 'sin fechas'}) + "
                       f"{'-imt:%d' % resto_t08 if resto_t08 else 'sin -imt'}"
                       f"   [{procedencia}]")
    except Exception as e:
        detalle_t08 = f"no se ha podido leer ({e})"

    print(f"  CSV        : {csv.name}")
    print(f"  variante   : {etiqueta_variante}   [{var_txt}]")
    print(f"  SIT        : TimeZone={tz} h   Latitude={lat}   Longitude={lon}")
    print(f"  T08        : {detalle_t08}")
    for a in avisos_t08:
        print(f"  [aviso] {a}")
    print(f"  MEF        : HourShiftF={hshiftf}  TimeShiftF={tshiftf}  "
          f"MeasureStep={paso}  UsesDST={usesdst}  RefTimeS={reftime}")
    print(f"  variante   : HourShift={v_hshift} h  TimeShift={v_tshift} min  "
          f"TimeShiftTotalMin={v_total}   (solo traza: ya no se usa para el -imt)")

    # El MEF ya no lo gestiona nadie: si trae desfase propio, suma por detras de
    # todo esto y desalinea el MET sin que se vea en ningun sitio.
    for clave, valor in (("HourShiftF", hshiftf), ("TimeShiftF", tshiftf)):
        if valor is not None and como_entero(valor) not in (0, None):
            print(f"  [aviso] el MEF declara {clave}={valor}: es un desfase de mas que la "
                  f"automatizacion NO gestiona (ya no escribe en el MEF). Quita esa linea "
                  f"salvo que la quieras a proposito.")

    # Serie medida: se lee del MISMO CSV que se le pasa al convert-meteo y con el
    # mapeo de la propia MEF (los campos van por posicion, no por nombre), para
    # comparar exactamente lo que entra contra lo que sale. Se lee antes de llamar
    # al CLI para que el analisis de curvas siga estando aunque el CLI falle.
    lon_f, tz_f = _a_float(lon), _a_float(tz)
    fmt = leer_formato_mef(mef)
    serie_raw, aviso_raw = leer_serie_raw(csv, fmt)
    if aviso_raw:
        print(f"  [aviso] {aviso_raw}")
    serie_sim = []

    # Mediodia solar esperado, para poder razonar el signo a mano.
    if lon_f is not None and tz_f is not None:
        dia_ref = serie_raw[len(serie_raw) // 2][0].date() if serie_raw else datetime.now().date()
        mediodia = mediodia_solar(dia_ref, lon_f, tz_f)
        h, m = int(mediodia), int(round((mediodia % 1) * 60))
        print(f"  esperado   : mediodia solar ~ {h:02d}:{m:02d} en la escala del MET "
              f"(dia de referencia {dia_ref})")

    if problema_variante:
        print(f"\n  [ERROR] {problema_variante}")
        print( "          run-simulation no podra validar el MET, asi que el diagnostico")
        print( "          quedara incompleto. Corrige variant.txt o el fichero de variante.")

    # --- convert-meteo SIN -imt ---
    met_check = ws / "Meteo" / f"{planta}{SUFIJO_CHECK}.MET"
    cmd = [
        str(cli), "convert-meteo",
        f"-icf:{csv}",
        f"-imf:{mef}",
        f"-isf:{sit}",
        f"-omf:{met_check}",
    ]
    if args.imt is not None:
        cmd.append(f"-imt:{args.imt}")
        print(f"\n  -> convert-meteo CON -imt:{args.imt}")
    else:
        print("\n  -> convert-meteo SIN -imt (PVsyst deduce el desfase de la config)")

    rc, salida = ejecutar(cmd, timeout=args.timeout_convert)
    print(f"     rc={rc}")

    det = desfase_detectado(salida)
    fuera_de_rango = bool(RE_RANGO.search(salida)) and "shift" in salida.lower()

    if rc != 0 or not met_check.exists():
        print("     [FAIL] convert-meteo no genero el MET.")
        if fuera_de_rango or det is not None:
            explicar(det, tz, total_t08)
        # Aunque no haya MET, el CSV crudo si se puede situar contra el mediodia
        # solar: si ya viene corrido de origen, eso es la causa raiz.
        analizar_curvas(serie_raw, [], lon_f, tz_f, total_t08)
        return False

    # --- lo que ha estampado PVsyst en el MET ---
    m_h = leer_campo(met_check, "HourShift")
    m_t = leer_campo(met_check, "TimeShift")
    m_tot = leer_campo(met_check, "TimeShiftTotalMin")
    print(f"     MET generado: HourShift={m_h}  TimeShift={m_t}  TimeShiftTotalMin={m_tot}")

    # Sin variante utilizable el diagnostico queda incompleto -> REVISAR.
    ok = problema_variante is None
    try:
        # --- validacion con run-simulation: aqui es donde PVsyst rechaza ---
        if not args.no_sim:
            if not variante:
                print("\n  [aviso] sin variant.txt no se puede validar con run-simulation")
            else:
                tmp = Path(tempfile.mkdtemp(prefix=f"tscheck_{planta}_"))
                try:
                    cmd = [
                        str(cli), "run-simulation",
                        f"-w:{ws}",
                        f"-p:{planta}.PRJ",
                        f"-v:{variante}",
                        "-ts:hour",
                        f"-s:{sit}",
                        f"-imf:{met_check}",
                    ]
                    if sfi.exists():
                        cmd.append(f"-isf:{sfi}")
                    cmd += [f"-ocf:{tmp / 'out.csv'}", "-odc",
                            f"-rpf:{tmp / 'out.pdf'}", "-rl:en"]
                    print(f"\n  -> run-simulation (validacion del MET, -ts:hour)")
                    rc2, salida2 = ejecutar(cmd, timeout=args.timeout_sim)
                    print(f"     rc={rc2}")
                    det2 = desfase_detectado(salida2)
                    if det2 is not None:
                        det = det2
                    if (tmp / "out.csv").exists():
                        # Hay que leerlo AQUI: el temporal se borra al salir.
                        serie_sim, aviso_sim = leer_serie_resultado(tmp / "out.csv")
                        if aviso_sim:
                            print(f"     [aviso] {aviso_sim}")
                    else:
                        ok = False
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)
    finally:
        if not args.keep:
            try:
                met_check.unlink()
            except OSError:
                pass
        else:
            print(f"\n  MET de prueba conservado en: {met_check}")

    # --- donde cae el pico: medido vs simulado vs mediodia solar ---
    # Esto no depende de que PVsyst reporte nada: mide la curva directamente, asi
    # que sirve tambien cuando el CLI acepta el MET sin rechistar pero el dia sale
    # corrido (que es justo el caso que no se detecta a ojo).
    ok_curvas, _ = analizar_curvas(serie_raw, serie_sim, lon_f, tz_f, total_t08)
    if ok_curvas is False:
        ok = False

    # --- veredicto ---
    print()
    if det is None:
        if ok:
            print("  [OK] PVsyst no ha reportado desfase y la curva sale centrada.")
        elif ok_curvas is False:
            print("  [FAIL] PVsyst no ha reportado desfase, pero la curva sale")
            print("         descentrada (ver arriba). Ajusta y repite.")
        elif problema_variante:
            print(f"  [REVISAR] convert-meteo ha ido bien, pero {problema_variante}:")
            print( "            no se ha podido comprobar el desfase que detecta PVsyst.")
        else:
            print("  [FAIL] la simulacion no ha producido resultados; revisa la salida de arriba.")
        return ok

    print(f"  DESFASE DETECTADO POR PVSYST: {det:+d} min")
    if abs(det) <= IMT_MAX:
        print(f"  [OK] dentro de [{IMT_MIN};{IMT_MAX}] -> la franja horaria esta bien puesta.")
        print(f"       Ese {det:+d} es el resto de partir el desfase de T08, y es lo que")
        print( "       auto_run.bat pasa como -imt (las horas las resuelve UsesDST/RefTimeS/")
        print( "       DateHEte/DateHHiver de la MEF; ver es_dst_fiable() en timeshift.py).")
        return ok
    print(f"  [FAIL] fuera de [{IMT_MIN};{IMT_MAX}] -> la franja horaria esta MAL puesta.")
    explicar(det, tz, total_t08)
    return False


def explicar(det, tz, total_t08=None):
    """Traduce el desfase medido en el ajuste que hay que hacer en T08_time_shifts.

    El unico numero que se toca a mano es `time_shift` de la planta en T08: de ahi
    salen solos el HourShiftF del MEF y el -imt del CLI (los reparte
    timeshift.py). `total_t08` es el valor que hay ahora en la tabla, si se ha
    podido leer.
    """
    if det is None:
        print("       No se ha podido leer el desfase de la salida del CLI; revisala arriba.")
        return
    # `det` va en la convencion de PVsyst: positivo = curva retrasada, asi que
    # hay que corregir en sentido contrario.
    correccion = -det
    if correccion == 0:
        return
    print()
    if total_t08 is None:
        print(f"       Ajuste: al `time_shift` de la planta en T08_time_shifts hay que")
        print(f"       sumarle {correccion:+d} min (no se ha podido leer el valor actual).")
    else:
        nuevo = total_t08 + correccion
        print(f"       Ajuste en T08_time_shifts:  time_shift  {total_t08:+d}  ->  {nuevo:+d} min")
        try:
            from timeshift import descomponer
            horas, resto = descomponer(nuevo)
            print(f"       De ahi saldran solos:  {horas:+d} h corregidas en las fechas de T08")
            print(f"       sobre el CSV raw, y {'convert-meteo -imt:%d' % resto if resto else 'sin -imt'}.")
        except Exception:
            pass
    print( "       Las horas solo se corrigen si en la fecha que dice T08 el CSV tiene de")
    print( "       verdad una hora repetida o una hora que falta (python timeshift.py revisar).")
    print( "       No toques a mano el MEF ni el TimeShift de la variante: el MEF ya no lo")
    print( "       gestiona nadie y la variante no se usa.")
    print( "       Si al aplicarlo el desfase EMPEORA, el signo va al reves: aplica el opuesto.")
    print()
    print( "       Y comprueba la causa de fondo: TimeZone del SIT debe ser la zona horaria")
    print(f"       CIVIL de la planta (Espana peninsular = 1.0; ahora {tz}).")
    print( "       Si el CSV viene en hora legal, lo limpio es TimeZone correcto y la MEF con")
    print( "       UsesDST=True / RefTimeS=LegalTime, dejando en T08 solo el desfase residual")
    print( "       del SCADA. Un desfase cableado a horario de verano vuelve a romper en el")
    print( "       cambio de hora.")


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="Corre convert-meteo sin -imt para diagnosticar la franja horaria.")
    ap.add_argument("plantas", nargs="*", help="codigos de planta (por defecto: los del inbox)")
    ap.add_argument("--csv", help="CSV concreto a convertir")
    ap.add_argument("--imt", type=int, help="pasar -imt:N (comprobacion del valor final)")
    ap.add_argument("--no-sim", action="store_true", help="no validar con run-simulation")
    ap.add_argument("--keep", action="store_true", help="conservar el MET de prueba")
    ap.add_argument("--ws", help=f"workspace PVsyst (def. {WS_DEFAULT})")
    ap.add_argument("--cli", help=f"PVsystCLI.exe (def. {CLI_DEFAULT})")
    ap.add_argument("--timeout-convert", type=int, default=900)
    ap.add_argument("--timeout-sim", type=int, default=3600)
    args = ap.parse_args()

    # Validacion de argumentos antes de tocar el entorno, para que el error hable
    # de lo que has escrito y no de un PVsystCLI que falta.
    if args.csv and len(args.plantas) > 1:
        print("[ERROR] --csv apunta a un unico fichero; no vale para varias plantas.")
        print("        Lanza una planta por corrida, o quita --csv para que cada una")
        print("        coja su CSV del inbox.")
        return 2

    cfg = cargar_config()
    pv  = cfg.get("pvsyst") or {}
    ws  = Path(args.ws  or pv.get("workspace") or WS_DEFAULT)
    cli = Path(args.cli or pv.get("cli")       or CLI_DEFAULT)
    inbox     = Path((cfg.get("paths") or {}).get("inbox")     or r"C:\Users\PVSYST1\PVSyst_CLI\inbox")
    proyectos = Path((cfg.get("paths") or {}).get("proyectos") or r"C:\Users\PVSYST1\PVSyst_CLI\projects")

    print(f"workspace : {ws}")
    print(f"CLI       : {cli}")
    print(f"inbox     : {inbox}")
    if not cli.exists():
        print(f"\n[ERROR] no se encuentra PVsystCLI en {cli}")
        return 2
    if not ws.is_dir():
        print(f"\n[ERROR] no existe el workspace {ws}")
        return 2

    plantas = [p.upper() for p in args.plantas]
    if args.csv and len(plantas) > 1:
        print("\n[ERROR] --csv apunta a un unico fichero; no vale para varias plantas.")
        print( "        Lanza una planta por corrida, o quita --csv para que cada una")
        print( "        coja su CSV del inbox.")
        return 2
    if not plantas:
        if not inbox.is_dir():
            print(f"\n[ERROR] no existe el inbox {inbox}")
            return 2
        plantas = sorted({f.name.split("_")[0].upper() for f in inbox.glob("*.csv")})
        if not plantas:
            print("\nNo hay CSV en el inbox y no se han indicado plantas. Nada que hacer.")
            return 0
        # El inbox es una COLA: auto_run.bat borra cada CSV en cuanto lo procesa
        # (auto_run.bat:256), asi que aqui solo quedan los pendientes. Que salga
        # una sola planta no significa que las demas esten bien: significa que ya
        # se procesaron. Para diagnosticarlas hay que nombrarlas a mano.
        print(f"plantas   : {', '.join(plantas)} (deducidas del inbox: solo las PENDIENTES)")
        print( "            para otra planta, pasala como argumento: check_timeshift.py PL2")
    print()

    resultados = {p: diagnosticar(p, ws, cli, inbox, proyectos, args) for p in plantas}

    print("=" * 70)
    print("  RESUMEN")
    for p, ok in resultados.items():
        print(f"    {p:<6} {'OK' if ok else 'REVISAR'}")
    print("=" * 70)
    return 0 if all(resultados.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
