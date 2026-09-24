r"""
Procedimiento pseudo-subhorario: N simulaciones horarias DIRECTAS sobre N grupos
del CSV raw -- uno por cada minuto distinto que traiga la marca de tiempo (0, 15,
30, 45 para un CSV de paso 15 min; N = minutos distintos, no un valor fijo) -- y
recombinacion de los N CSV de resultado -- intercalados por fecha real -- en una
sola serie cronologica.

Es la adaptacion al CLI del ejemplo "Pseudo-sub-hourly simulation" de la
documentacion de PVsystCLI (el motor -ts:subhour nativo de PVsyst puede fallar
con datos cuarto-horarios, o de otros pasos sub-horarios, con "weather data is
hourly" aunque el CSV sea genuinamente sub-horario). ESTA ES LA TECNICA QUE TRAE
EL PROPIO PVSYST -- copiada del material que instala PVsyst 8.1.4 en esta misma
maquina, no reinventada:

  - Documentacion: "C:\Program Files\PVsyst8.1.4\help-cli\use-cases\
    converting-weather.html#example-3-pseudo-sub-hourly-simulation-preparation"
    y "...\use-cases\simulation.html#example-2-pseudo-sub-hourly-simulation".
    Cita literal (converting-weather.html): "Copy MEF file for each minute
    stamp and adapt the time shift parameter. In a hourly simulation, PVsyst
    defines the sun position at the 30' mark (center of 1 hour interval). In
    the example this means that for the recording interval 0-15', with center
    at 7', the time shift needs to be -23', in addition to any other time
    shift present in the data."
  - Script de referencia (instalado junto con el CLI, no en este repo):
    "C:\Program Files\PVsyst8.1.4\DataRO\PVsyst8.1_Data\CLI\Ressources\Examples\
    ScriptsPython\Demo_PVsystCLI_fun.py" (funciones split_csv_by_time,
    GetTimeShift, SetMinInCSVRes/offset_time_in_CSV, CombSubhourlyRes).
  - Tambien referenciado en el paper enlazado desde la documentacion: "A model
    correcting the effect of sub-hourly irradiance fluctuations on overload
    clipping losses in hourly simulations" (pvsyst.com/pdf/company/publications
    /articles/...).

La tecnica, en 3 pasos (ver GetTimeShift/desfase_centrado y
escribir_mef_measurestep_60 mas abajo):
  1. Particionar el CSV por el minuto REAL de la marca (grupos_de_marcas):
     cada grupo se queda solo con las filas de ESE minuto, sin tocar sus
     marcas de tiempo (escribir_csv_grupo) -- 1 fila por hora, no 1 fila por
     dia: para paso 15 min, el grupo "minuto=0" tiene las filas de :00 de
     TODAS las horas del periodo.
  2. Convertir cada grupo con una copia del MEF real donde se fuerza
     MeasureStep=60 (escribir_mef_measurestep_60): le dice a PVsyst "esto ES
     una serie horaria", una fila por hora, tal cual esta grabada. Y un -imt
     de CENTRADO por grupo (desfase_centrado = round(paso/2 + minuto - 30)),
     que le dice a PVsyst cuanto compensar porque la muestra no fue tomada en
     el minuto 30 (centro asumido de una hora) sino en `minuto`. El -imt
     "base" que ya trae la planta (T08_time_shifts) se SUMA a este centrado
     (--imt): son dos correcciones independientes, no una sustituye a la otra.
  3. Simular cada grupo -ts:hour (MET ya declarado como horario) y recombinar
     los N CSV de resultado -- ver combinar_resultados, sin cambios respecto a
     versiones anteriores de este fichero: no depende de la tecnica usada para
     generar los grupos, solo de (csv_resultado, minuto_del_grupo).

HISTORIAL (por que no es la primera version de este fichero):
  - Una implementacion anterior de esta MISMA tecnica (particion + MeasureStep
    forzado + -imt de centrado) se proba el 2026-09-16 y parecia no funcionar:
    variar el -imt de centrado drasticamente (-29 vs +29 sobre el mismo grupo)
    apenas cambiaba el resultado medido (-22,7 vs -24,7 min), con un sesgo
    estructural de ~-24 min por grupo. La causa mas probable (no confirmada
    entonces) es que el MeasureStep NO se estuviera forzando de verdad al
    convertir -- si el MET seguia siendo de paso 15 real, run-simulation con
    -ts:hour reagrega usando la posicion solar real de cada muestra
    cuarto-horaria (grid horario real), y el -imt de centrado, pensado para un
    MET genuinamente horario, no tiene ese efecto: de ahi que pareciera
    "irrelevante". No se investigo mas a fondo y se descarto la tecnica.
  - Se sustituyo (commit "Reescribe pseudo_subhour.py: tecnica por fases",
    2026-09-17) por desplazar TODA la linea de tiempo -P minutos y dejar que
    -ts:hour reagregue por hora real sobre esa linea desplazada, con el MEF
    real sin modificar. Funcionaba para P=0/15/30, pero P=45 hace que
    convert-meteo/run-simulation detecten un desfase horario de -45 min
    respecto al SIT y lo rechacen: "Invalid weather file: the time shift
    detected is -45 minutes" (visto en produccion sobre FRA el 2026-09-18,
    con el CSV completo de 5 meses; la verificacion puntual del 2026-09-17
    debio hacerse sobre una muestra que no disparo ese chequeo). Cualquier
    desplazamiento fisico de -45 min es, literal y correctamente, un desfase
    horario de -45 min para PVsyst -- la tecnica no tiene forma de evitar que
    la fase 45 choque con ese limite.
  - Esta version vuelve a la tecnica de particion + MeasureStep forzado
    (identica a la de la documentacion oficial), corrigiendo lo que
    probablemente fallo en el intento de 2026-09-16: escribir_mef_measurestep_60
    fuerza explicitamente el MeasureStep de la copia del MEF usada para
    convertir cada grupo, en vez de asumir que ya viene forzado.
  - Probado en produccion (2026-09-18/24) SOLO con esto, el grupo 30 seguia
    fallando igual: "Invalid weather file: the time shift detected is -51
    minutes" con imt=+9 (base +1 + centrado +8) -- un desfase "detectado" muy
    superior al -imt real que se le paso, que crece con el minuto del grupo
    (contrastado con pruebas rapidas aisladas: convert-meteo+run-simulation
    rechaza la carga del MET en los primeros segundos, sin esperar a la
    simulacion completa, asi que calibrar esto es barato). MeasureStep=60
    forzado sobre un MEF cuyo paso real es 15 introduce, ademas del -imt que
    le pasamos, un desfase propio que PVsyst suma al calcular si el fichero es
    "valido" -- no es un problema de escribir_csv_grupo ni de la formula de
    centrado, es el chequeo pi_TimeShiftMax de PVsyst (ver mas abajo).
  - LA PIEZA QUE FALTABA: el script de referencia de PVsyst SI contempla este
    chequeo -- su funcion runSim pasa `-ipf:{params_filename}` con el
    comentario explicito "Set param file to deactivate timeshift verification".
    Ese fichero de parametros (Sources\Param_Modif_SingleDay.dat en el propio
    material de PVsyst) tiene una unica linea util:
    "pi_TimeShiftMax;300.0000;40.0000;min;Maximum allowed time shift in
    weather data" -- el limite que da "Invalid weather file" cuando se supera.
    En vez de perseguir un -imt que dé un desfase "detectado" cercano a 0 (fragil:
    no se conoce la formula exacta de PVsyst para ese numero, y no hay garantia
    de que generalice a otra planta u otro paso), este fichero
    (pseudo_subhour_params.dat, junto a este script) sube ese limite a 120 min
    -- comodo por encima de lo que puede dar cualquier grupo de un CSV
    cuarto-horario -- y se pasa con -ipf a CADA run-simulation de este
    procedimiento. Confirmado con pruebas rapidas (aisladas, sin esperar la
    simulacion completa) sobre el grupo 30 (imt +9) y el grupo 45 (imt +23) de
    FRA: ambos, que antes se rechazaban, pasan el chequeo con -ipf y entran a
    simular.

Uso desde auto_run.bat (dos comandos independientes):

    python pseudo_subhour.py modo PLANTA
        -> imprime "true" o "false" en stdout: si T01_plants (plants_config.xlsx)
           marca aggregate_by_hour=true para esa planta. NUNCA falla el CSV: ante
           cualquier problema (Excel inaccesible, planta sin fila, columna
           ausente...) imprime "false" (avisa por stderr) para que el .bat siga
           con el comportamiento de siempre -- intentar -ts:subhour primero.

    python pseudo_subhour.py ejecutar PLANTA --ws WS --cli CLI --prj PRJ
        --variant VAR --sit SIT --mef MEF --csv CSV [--imt N] [--sfi SFI]
        --out RES_CSV
        -> por cada grupo (minuto distinto que traiga --csv) escribe un CSV solo
           con las filas de ese minuto, convierte con una copia del MEF con
           MeasureStep forzado a 60 y el -imt de centrado correspondiente,
           ejecuta run-simulation -ts:hour, y combina los CSV de resultado --
           intercalados por fecha real -- en --out. Si cualquier grupo falla se
           aborta TODO (no se deja un --out a medias): mejor reintentar en el
           siguiente ciclo que dejar una serie con huecos sin que se note.
           Codigo de salida 0/1.

Este script es DELIBERADAMENTE independiente de auto_run.bat en lo que hace: solo
importa de timeshift.py los lectores/escritores ya probados de Excel/MEF/CSV
(nada de timeshift.py se modifica ni se reescribe aqui), asi que si el
procedimiento pseudo-subhorario fallara por algo imprevisto, el camino de siempre
(subhour / hour directo) sigue intacto y no se ve afectado.

NORMALIZACION DE LA MARCA DE SALIDA: run-simulation -ts:hour escribe SIEMPRE
':00' en la columna 'date' del CSV de resultado, con independencia del minuto
real de la marca de entrada (los N grupos salen todos etiquetados ':00', con
valores DISTINTOS entre si). Por eso combinar_resultados() le suma el minuto del
grupo a la fecha de salida ANTES de ordenar/combinar (funcion _con_minuto),
restaurando la hora de calendario real: es exactamente el paso
SetMinInCSVRes/offset_time_in_CSV del script de referencia de PVsyst. Sin este
paso los N grupos se apilarian en la misma marca en vez de intercalarse. La
reescala de energia de cada fila (factor_energia = paso/60, ver _escalar_fila)
es la misma idea que CombinedPower_List del script de referencia: cada fila de
un grupo sigue siendo, en el fondo, una MEDIA horaria (no una muestra
instantanea de `paso` minutos), asi que hay que repartir esa energia entre los
N grupos para no contarla N veces.
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from timeshift import (
    cargar_config,
    localizar_excel,
    leer_formato_mef,
    parsear_fecha,
    rehacer_fecha,
    _leer_lineas,
    leer_marcas,
    _filas_tabla,
    WS_DEFAULT,
)

NOMBRE_TABLA_PLANTAS = "T01_plants"
CARPETA_TMP = "pvsyst_pseudo_subhour"
PREF = "    "

# -ipf: sube pi_TimeShiftMax (ver docstring del modulo) para que run-simulation
# no rechace los MET con MeasureStep forzado como "Invalid weather file" --
# equivalente a Param_Modif_SingleDay.dat del script de referencia de PVsyst.
PARAMS_TIMESHIFT = Path(__file__).with_name("pseudo_subhour_params.dat")

RE_FILA_DATOS = re.compile(r"^\s*\d{1,2}/\d{1,2}/\d{2,4}\s+\d{1,2}:\d{2}\s*;")


# --------------------------------------------------------------------------
# aggregate_by_hour (T01_plants)
# --------------------------------------------------------------------------
def _a_bool(valor) -> bool:
    if isinstance(valor, bool):
        return valor
    if valor is None:
        return False
    if isinstance(valor, (int, float)):
        return bool(valor)
    return str(valor).strip().lower() in ("true", "1", "si", "sí", "yes", "x", "verdadero")


def leer_aggregate_by_hour(xlsx: Path) -> dict[str, bool]:
    """{PLANTA: aggregate_by_hour} desde T01_plants."""
    filas = _filas_tabla(xlsx, NOMBRE_TABLA_PLANTAS)
    if not filas:
        return {}
    cabecera = [str(c).strip().lower() if c is not None else "" for c in filas[0]]

    def indice(*nombres):
        for n in nombres:
            if n in cabecera:
                return cabecera.index(n)
        return None

    i_planta = indice("plant_code", "planta", "plant")
    i_agg = indice("aggregate_by_hour")
    if i_planta is None or i_agg is None:
        raise RuntimeError(
            f"{NOMBRE_TABLA_PLANTAS} necesita las columnas 'plant_code' y "
            f"'aggregate_by_hour'; se han leido: {', '.join(c for c in cabecera if c)}"
        )

    resultado: dict[str, bool] = {}
    for fila in filas[1:]:
        planta = fila[i_planta] if i_planta < len(fila) else None
        if planta is None or not str(planta).strip():
            continue
        valor = fila[i_agg] if i_agg < len(fila) else None
        resultado[str(planta).strip().upper()] = _a_bool(valor)
    return resultado


def cmd_modo(args) -> int:
    """Imprime 'true'/'false'. No falla nunca: ante cualquier error, 'false' + aviso por stderr."""
    planta = args.planta.strip().upper()
    try:
        cfg = cargar_config()
        xlsx, _ = localizar_excel(cfg)
        valor = leer_aggregate_by_hour(xlsx).get(planta, False)
    except Exception as e:
        print(f"[AVISO] no se pudo leer aggregate_by_hour de {NOMBRE_TABLA_PLANTAS} "
              f"para {planta}, se asume false (se intentara subhour): {e}", file=sys.stderr)
        valor = False
    print("true" if valor else "false")
    return 0


# --------------------------------------------------------------------------
# Fases (desplazamiento de la linea de tiempo completa)
# --------------------------------------------------------------------------
def grupos_de_marcas(marcas) -> list[int]:
    """Grupos (minutos reales) a simular: los minutos que aparecen DE VERDAD en
    los datos, no el `paso` declarado en la MEF -- da igual que el CSV sea de
    15, 10, 20 o 5 minutos, o que falten muestras. Cada valor de minuto
    distinto en la columna de fecha es un grupo.
    """
    return sorted({m.valor.minute for m in marcas})


def desfase_centrado(paso: int, minuto: int) -> int:
    """-imt de centrado para el grupo `minuto`, formula GetTimeShift del script
    de referencia de PVsyst (ver docstring del modulo).

    PVsyst asume, en una simulacion horaria, que la muestra representa el
    centro de la hora (minuto 30). Un grupo de este procedimiento junta las
    muestras tomadas en el minuto real `minuto` de cada hora (recording
    interval [minuto, minuto+paso)); su centro real es minuto + paso/2. La
    diferencia entre ese centro real y el minuto 30 asumido es lo que hay que
    pasarle a convert-meteo como -imt para que la posicion solar se calcule
    donde de verdad se tomo la muestra.

    Ejemplo de la propia documentacion de PVsyst (converting-weather.html):
    paso=15, minuto=0 -> intervalo 0-15', centro en 7' -> imt=7-30=-23 (con
    redondeo distinto, aqui sale -22; la diferencia de 1 min esta dentro del
    ruido que la propia documentacion senala en otros ejemplos).
    """
    return round(paso / 2 + minuto - 30)


def escribir_mef_measurestep_60(mef: Path, destino: Path) -> None:
    """Copia de `mef` con MeasureStep forzado a 60 (resto de campos intactos:
    TimeShiftF, UsesDST, DateHEte/DateHHiver, formato de columnas, etc.).

    Paso 3 de la documentacion de PVsyst (converting-weather.html, ejemplo de
    pseudo-sub-hourly): "Copy MEF file for each minute stamp and adapt the time
    shift parameter" -- aqui basta una unica copia (el MeasureStep forzado no
    depende del grupo, solo el -imt de desfase_centrado), reutilizada para
    convertir los N grupos. Le dice a PVsyst "trata cada fila de este CSV como
    una hora completa", que es justo lo que necesita un CSV ya particionado
    por minuto (1 fila por hora, no por dia).
    """
    texto = mef.read_text(encoding="cp1252", errors="replace")
    if re.search(r"^\s*MeasureStep=.*$", texto, re.MULTILINE):
        texto = re.sub(r"^(\s*MeasureStep=).*$", r"\g<1>60", texto, count=1, flags=re.MULTILINE)
    else:
        texto += "\nMeasureStep=60\n"
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text(texto, encoding="cp1252", errors="replace")


def escribir_csv_grupo(lineas: list[str], fmt: dict, grupo_min: int, destino: Path) -> int:
    """Copia del CSV solo con las filas cuyo minuto real es `grupo_min`, SIN
    tocar sus marcas de tiempo (a diferencia de la tecnica por fases que
    reemplazo esta funcion: aqui se filtra, no se desplaza).

    Paso 1 de la documentacion de PVsyst (converting-weather.html): "Process
    sub-hourly data to obtain one CSV file for each minute time stamp." Cada
    grupo resultante tiene 1 fila por hora real del periodo (no 1 fila por
    dia): para paso 15 min, el grupo minuto=0 recoge las filas de :00 de TODAS
    las horas.

    Reutiliza parsear_fecha de timeshift.py (mismo mecanismo que usa
    timeshift.py para leer horas) solo para decidir el minuto de cada fila; el
    texto de la fila se copia tal cual. Devuelve el numero de filas escritas.
    """
    sep, col, orden = fmt["separador"], fmt["campo_fecha"], fmt["orden_fecha"]
    cabecera = lineas[: fmt["cabecera"]]
    nuevas = list(cabecera)
    n = 0
    for linea in lineas[fmt["cabecera"]:]:
        if not linea.strip():
            continue
        cuerpo = linea.rstrip("\r\n")
        trozos = cuerpo.split(sep)
        if len(trozos) < col:
            continue
        valor = parsear_fecha(trozos[col - 1], orden)
        if valor is None or valor.minute != grupo_min:
            continue
        nuevas.append(linea)
        n += 1
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_bytes("".join(nuevas).encode("latin-1"))
    return n


# --------------------------------------------------------------------------
# Recombinacion de los CSV de resultado
# --------------------------------------------------------------------------
def _particion_header_datos(lineas: list[str]) -> tuple[list[str], list[str]]:
    """(cabecera, filas_de_datos) de un CSV de resultados de run-simulation.

    Las filas de datos se localizan por FORMA (empiezan por 'DD/MM/YY HH:MM;'),
    no contando un numero fijo de lineas de cabecera: cuantas lineas de metadatos
    escribe run-simulation no esta documentado como estable entre variantes.
    """
    for i, linea in enumerate(lineas):
        if RE_FILA_DATOS.match(linea):
            return lineas[:i], lineas[i:]
    raise RuntimeError("no se ha encontrado ninguna fila de datos (ninguna linea empieza por una fecha)")


def _fecha_salida(linea: str) -> dt.datetime:
    """Fecha de una fila de resultado 'DD/MM/YY HH:MM;...'.

    Se suma con timedelta (no strptime) por lo mismo que timeshift.parsear_fecha:
    PVsyst puede escribir 24:00 para el final del dia, y strptime lo rechazaria.
    """
    texto = linea.split(";", 1)[0].strip()
    fecha_str, hora_str = texto.split(" ", 1)
    dia, mes, anio = (int(p) for p in fecha_str.split("/"))
    if anio < 100:
        anio += 2000
    hora, minuto = (int(p) for p in hora_str.split(":"))
    return dt.datetime(anio, mes, dia) + dt.timedelta(hours=hora, minutes=minuto)


def _indices_potencia(cabecera: list[str]) -> list[int]:
    """Indices (0-based, por posicion tras el ';') de las columnas cuya unidad
    lleva 'W' -- potencia (kW) o irradiancia (W/m2). Mismo criterio que
    PwrUnit_List en CombSubhourlyRes del script de referencia de PVsyst: son
    las columnas que PVsyst integra sobre la duracion del paso, asi que hay
    que reescalarlas al paso real (ver _escalar_fila).
    """
    for i, linea in enumerate(cabecera):
        campos = linea.rstrip("\r\n").split(";")
        if campos and campos[0].strip().lower() == "date" and i + 1 < len(cabecera):
            unidades = cabecera[i + 1].rstrip("\r\n").split(";")
            return [j for j, u in enumerate(unidades) if "W" in u]
    return []


def _escalar_fila(linea: str, indices_potencia: list[int], factor: float) -> str:
    """Multiplica por `factor` los campos de `indices_potencia`.

    PVsyst calcula estos valores tratando cada fila como si fuera una hora
    completa (es una simulacion -ts:hour), asi que lo que reporta en 'kW' o
    'W/m2' es, en la practica, la energia/irradiacion de esa fila calculada
    para 60 minutos -- pero cada fila de este procedimiento representa en
    realidad solo `paso` minutos (15 en el caso cuarto-horario). `factor` =
    paso_real/60 (0,25 para paso 15, o sea /4) corrige esas columnas a lo que
    de verdad aporta esa fila. Sin esto, quien sume estas columnas aguas abajo
    (Fabric/csv_ingest) contaria 60/paso veces mas energia de la real: un CSV
    cuarto-horario sin corregir tiene 4x mas filas, cada una con el valor de
    una hora completa, y sumaria x4 la energia real del periodo.

    Formula identica a CombinedPower_List[idx] += power_value * (timestep/60)
    del script de referencia de PVsyst (ver docstring del modulo), solo que
    aqui se aplica a CADA fila (no solo a un total agregado), porque el CSV
    combinado se consume fila a fila aguas abajo, no como un unico total.

    Los numeros van con coma decimal (formato de PVsyst en este locale), no
    punto: se convierte ida y vuelta.
    """
    campos = linea.rstrip("\r\n").split(";")
    for i in indices_potencia:
        if i >= len(campos):
            continue
        texto = campos[i].strip()
        if not texto:
            continue
        try:
            valor = float(texto.replace(",", "."))
        except ValueError:
            continue
        texto_nuevo = f"{valor * factor:.6f}".rstrip("0").rstrip(".")
        campos[i] = texto_nuevo.replace(".", ",")
    return ";".join(campos) + "\n"


def _con_minuto(linea: str, minuto: int) -> tuple[dt.datetime, str]:
    """(fecha_real, linea_reescrita) sumando `minuto` a la marca de la fila.

    CONFIRMADO EMPIRICAMENTE (prueba real sobre FRA, 2026-09-01): run-simulation
    -ts:hour normaliza SIEMPRE la marca de salida a :00, sin importar el minuto
    real del .MET de entrada -- los N grupos de un CSV cuarto-horario salen
    todos etiquetados ':00' (con valores distintos entre si: la agregacion en
    si usa la marca real de cada fila del grupo, sin tocar -- ver
    escribir_csv_grupo; solo la etiqueta de fecha de salida se pierde). Sin
    este paso, la recombinacion de mas abajo apilaria los N grupos en la misma
    marca en vez de intercalarlos. Es exactamente el paso SetMinInCSVRes/
    offset_time_in_CSV del script de referencia de PVsyst (ver docstring del
    modulo): sumar el minuto del grupo a la fecha de salida ANTES de combinar.
    """
    fecha = _fecha_salida(linea) + dt.timedelta(minutes=minuto)
    resto = (linea.split(";", 1)[1] if ";" in linea else "").rstrip("\r\n")
    return fecha, f"{fecha:%d/%m/%y %H:%M};{resto}\n"


def combinar_resultados(ficheros_minuto: list[tuple[Path, int]], destino: Path,
                        factor_energia: float) -> int:
    """Une los CSV de resultado (uno por grupo) en uno solo, ordenado por fecha.

    `ficheros_minuto` es [(csv_del_grupo, minuto_del_grupo), ...]. Antes de
    combinar se le suma `minuto` a la marca de cada fila (ver _con_minuto): sin
    eso los 4 grupos saldrian todos etiquetados ':00' y se apilarian en vez de
    intercalarse.

    `factor_energia` (paso_real/60) reescala las columnas de potencia/
    irradiancia de CADA fila (ver _escalar_fila): sin esto, cada una de las
    4x mas filas del CSV cuarto-horario llevaria el valor de una hora
    completa, y quien sume esas columnas aguas abajo contaria x4 la energia
    real del periodo. Con paso=60 (caso degenerado de un unico grupo, datos
    realmente horarios) factor_energia sale 1.0 y no cambia nada.

    La cabecera (metadatos + nombres de columna + unidades) se toma del PRIMER
    fichero: es igual en todos los grupos salvo el nombre del .MET de origen, que
    no le importa a nadie aguas abajo (Fabric/csv_ingest lee a partir de la fila
    'date;...', no esas lineas de metadatos).
    """
    cabecera = None
    indices_potencia: list[int] = []
    filas: list[tuple[dt.datetime, str]] = []
    for ruta, minuto in ficheros_minuto:
        lineas = ruta.read_bytes().decode("latin-1").splitlines(keepends=True)
        cab, datos = _particion_header_datos(lineas)
        if cabecera is None:
            cabecera = cab
            indices_potencia = _indices_potencia(cabecera)
        for linea in datos:
            if not linea.strip():
                continue
            if indices_potencia and factor_energia != 1.0:
                linea = _escalar_fila(linea, indices_potencia, factor_energia)
            filas.append(_con_minuto(linea, minuto))

    if not filas:
        raise RuntimeError("ningun grupo devolvio filas de datos")

    filas.sort(key=lambda t: t[0])

    destino.parent.mkdir(parents=True, exist_ok=True)
    with open(destino, "wb") as f:
        f.write("".join(cabecera).encode("latin-1"))
        f.write("".join(linea for _, linea in filas).encode("latin-1"))
    return len(filas)


# --------------------------------------------------------------------------
# Comando "ejecutar"
# --------------------------------------------------------------------------
def _ejecutar_cli(args_cli: list[str], log: list[str], etiqueta: str) -> int:
    proc = subprocess.run(args_cli, capture_output=True, text=True, errors="replace")
    salida = (proc.stdout or "") + (proc.stderr or "")
    log.append(f"--- {etiqueta} ---")
    log.append(" ".join(args_cli))
    if salida.strip():
        log.append(salida.rstrip("\n"))
    return proc.returncode


def cmd_ejecutar(args) -> int:
    planta = args.planta.strip().upper()
    log: list[str] = []

    def fallar(msg: str) -> int:
        print(f"{PREF}[PSEUDO-SUBHOUR] {planta}: [ERROR] {msg}")
        for linea in log:
            print(f"{PREF}  {linea}")
        return 1

    cfg = cargar_config()
    ws = Path(args.ws or (cfg.get("pvsyst") or {}).get("workspace") or WS_DEFAULT)
    cli = Path(args.cli)
    mef = Path(args.mef)
    csv = Path(args.csv)
    sit = Path(args.sit)
    salida_final = Path(args.out)

    if not cli.is_file():
        return fallar(f"no existe PVsystCLI: {cli}")
    if not mef.is_file():
        return fallar(f"no existe el MEF: {mef}")
    if not csv.is_file():
        return fallar(f"no existe el CSV: {csv}")
    if not sit.is_file():
        return fallar(f"no existe el SIT: {sit}")

    try:
        fmt = leer_formato_mef(mef)
        lineas = _leer_lineas(csv)
        marcas, ilegibles = leer_marcas(lineas, fmt)
    except Exception as e:
        return fallar(f"no se pudo leer el CSV con el formato del MEF: {e}")
    if not marcas:
        return fallar(f"no se ha podido leer ninguna marca de tiempo de {csv.name}")

    grupos = grupos_de_marcas(marcas)
    log.append(f"CSV: {csv.name}  {len(marcas):,} filas"
               + (f"  ({ilegibles} lineas ilegibles)" if ilegibles else ""))
    log.append(f"grupos (minutos distintos en la marca): {grupos}")
    if len(grupos) < 2:
        log.append(f"aviso: solo se ha visto un minuto ({grupos[0]}) en el CSV; "
                   f"el resultado equivale a -ts:hour directo")

    try:
        imt_base = int(args.imt)
    except (TypeError, ValueError):
        imt_base = 0
    if not (-30 <= imt_base <= 30):
        return fallar(f"-imt base={imt_base} fuera de rango [-30,30]. Revisa el "
                      f"time_shift de {planta} en T08_time_shifts.")

    sfi_arg = []
    if args.sfi and Path(args.sfi).is_file():
        sfi_arg = [f"-isf:{args.sfi}"]

    if not PARAMS_TIMESHIFT.is_file():
        return fallar(f"falta {PARAMS_TIMESHIFT.name} (junto a este script): sin el, "
                      f"run-simulation rechaza los MET con MeasureStep forzado como "
                      f"'Invalid weather file' -- ver docstring del modulo (-ipf)")
    ipf_arg = [f"-ipf:{PARAMS_TIMESHIFT}"]

    base_tmp = Path(tempfile.gettempdir()) / CARPETA_TMP
    base_tmp.mkdir(parents=True, exist_ok=True)
    tmp_dir = Path(tempfile.mkdtemp(prefix=f"{planta}_", dir=str(base_tmp)))

    resultados: list[tuple[Path, int]] = []
    try:
        mef_forzado = tmp_dir / f"{planta}_measurestep60.MEF"
        escribir_mef_measurestep_60(mef, mef_forzado)
        log.append(f"MEF con MeasureStep forzado a 60: {mef_forzado.name} "
                   f"(a partir de {mef.name}, paso real {fmt['paso']} min)")

        for grupo in grupos:
            etiqueta_grupo = f"grupo{grupo:02d}"
            csv_grupo = tmp_dir / f"{planta}_{etiqueta_grupo}.csv"
            met_grupo = ws / "Meteo" / f"{planta}_pseudo_{etiqueta_grupo}.MET"
            res_grupo = tmp_dir / f"{planta}_{etiqueta_grupo}_result.csv"

            n_filas_grupo = escribir_csv_grupo(lineas, fmt, grupo, csv_grupo)
            imt_centrado = desfase_centrado(fmt["paso"], grupo)
            imt_total = imt_base + imt_centrado

            # Copia del MEF con MeasureStep=60 (no el real): le dice a PVsyst
            # que cada fila de este grupo -- ya filtrado a 1 fila/hora por
            # escribir_csv_grupo -- ES una hora completa. El -imt centra la
            # posicion solar en el minuto real de la muestra (ver
            # desfase_centrado); es la tecnica documentada por PVsyst, no la
            # agregacion nativa de -ts:hour que usaba la version anterior.
            rc = _ejecutar_cli(
                [str(cli), "convert-meteo", f"-icf:{csv_grupo}", f"-imf:{mef_forzado}",
                 f"-isf:{sit}", f"-omf:{met_grupo}", f"-imt:{imt_total}"],
                log, f"convert-meteo {etiqueta_grupo}",
            )
            if rc != 0 or not met_grupo.is_file():
                return fallar(f"convert-meteo fallo en el {etiqueta_grupo} "
                              f"({n_filas_grupo} filas, imt {imt_total:+d} "
                              f"= base {imt_base:+d} + centrado {imt_centrado:+d})")

            # -ipf sube pi_TimeShiftMax (ver PARAMS_TIMESHIFT / docstring del
            # modulo): sin esto run-simulation rechaza este MET como "Invalid
            # weather file" por el desfase propio de forzar MeasureStep=60
            # sobre un MEF de paso real distinto -- independiente de imt_total.
            rc = _ejecutar_cli(
                [str(cli), "run-simulation", f"-w:{ws}", f"-p:{args.prj}",
                 f"-v:{args.variant}", "-ts:hour", f"-s:{sit}", f"-imf:{met_grupo}",
                 *sfi_arg, *ipf_arg, f"-ocf:{res_grupo}", "-odc", "-rl:en"],
                log, f"run-simulation {etiqueta_grupo}",
            )
            try:
                met_grupo.unlink()
            except OSError:
                pass
            if rc != 0 or not res_grupo.is_file():
                return fallar(f"run-simulation fallo en el {etiqueta_grupo} "
                              f"({n_filas_grupo} filas, imt {imt_total:+d})")

            log.append(f"{etiqueta_grupo}: {n_filas_grupo} filas, "
                       f"imt {imt_total:+d} (base {imt_base:+d} + centrado {imt_centrado:+d}) -> OK")
            resultados.append((res_grupo, grupo))

        factor_energia = fmt["paso"] / 60.0
        try:
            n_filas = combinar_resultados(resultados, salida_final, factor_energia)
        except Exception as e:
            return fallar(f"no se pudieron combinar los CSV de resultado: {e}")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    log.append(f"columnas de potencia/irradiancia reescaladas x{factor_energia:g} "
               f"(paso {fmt['paso']} min / 60) para que la energia por fila sea la real, "
               f"no la de una hora completa")
    print(f"{PREF}[PSEUDO-SUBHOUR OK] {planta}: {len(grupos)} grupo(s) "
          f"(minutos {', '.join(f'{g:02d}' for g in grupos)}), {n_filas:,} filas combinadas.")
    if args.verbose:
        for linea in log:
            print(f"{PREF}  {linea}")
    return 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Procedimiento pseudo-subhorario: N simulaciones -ts:hour, "
                    "una por cada grupo (minuto real) del CSV raw, con el MEF "
                    "copiado a MeasureStep=60 y el -imt de centrado de cada "
                    "grupo, y recombinacion de los CSV de resultado.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("modo", help="true/false: aggregate_by_hour de T01_plants para esa planta")
    m.add_argument("planta")
    m.set_defaults(func=cmd_modo)

    e = sub.add_parser("ejecutar", help="ejecuta el procedimiento pseudo-subhorario completo")
    e.add_argument("planta")
    e.add_argument("--ws", help=f"workspace PVsyst (def. {WS_DEFAULT})")
    e.add_argument("--cli", required=True, help="ruta de PVsystCLI.exe")
    e.add_argument("--prj", required=True, help="fichero .PRJ (p.ej. PLANTA.PRJ)")
    e.add_argument("--variant", required=True, help="variante activa (p.ej. VGH)")
    e.add_argument("--sit", required=True, help="ruta del .SIT")
    e.add_argument("--mef", required=True, help="ruta del .MEF")
    e.add_argument("--csv", required=True,
                   help="CSV raw ya corregido por timeshift.py (el mismo que uso "
                        "el convert-meteo horario/subhorario que acaba de fallar)")
    e.add_argument("--imt", default="0", help="minutos del -imt (igual que el de la conversion principal)")
    e.add_argument("--sfi", default=None, help="ruta del .SFI, si existe")
    e.add_argument("--out", required=True, help="CSV final combinado")
    e.add_argument("-v", "--verbose", action="store_true", help="volcar el detalle tambien si sale bien")
    e.set_defaults(func=cmd_ejecutar)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
