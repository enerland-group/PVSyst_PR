r"""
Procedimiento pseudo-subhorario: N simulaciones horarias DIRECTAS (con el MEF
real de la planta, sin tocar) sobre N copias completas del CSV raw, cada una con
TODA su linea de tiempo desplazada a una fase distinta (0, 15, 30, 45 min para un
CSV de paso 15 min; N = minutos distintos que traiga el CSV, no un valor fijo), y
recombinacion de los N CSV de resultado -- intercalados por fecha real -- en una
sola serie cronologica.

Es la adaptacion al CLI del ejemplo "Pseudo-sub-hourly simulation" de la
documentacion de PVsystCLI (el motor -ts:subhour nativo de PVsyst puede fallar
con datos cuarto-horarios, o de otros pasos sub-horarios, con "weather data is
hourly" aunque el CSV sea genuinamente sub-horario) -- pero NO con la tecnica que
trae el script de referencia de PVsyst (partir el CSV por minuto en N CSV de 1
fila/hora, convertirlos con un MEF forzado a MeasureStep=60 y pasar un -imt de
centrado por grupo calculado con GetTimeShift). Esa tecnica se probo a fondo el
2026-09-16 y quedo DESCARTADA (ver historial): tanto el -imt de centrado como la
marca de tiempo literal del CSV de grupo resultaron IRRELEVANTES para la
posicion solar que usa run-simulation en ese modo (contrastado con -imt:-29 vs
-imt:+29 sobre el mismo grupo: -22,7 vs -24,7 min, diferencia dentro del ruido) --
la tecnica dejaba un sesgo estructural de ~-24 min por grupo (~-45 min al combinar
los 4), sin ninguna palanca de entrada capaz de corregirlo.

LA TECNICA DE AQUI (por FASES, no por grupos) se apoya en el camino que SI esta
validado: la conversion "directa" (MEF real, sin ningun MeasureStep forzado) que
ya usan con exito T01_plants.aggregate_by_hour=true (PL1, PL2) y el propio FRA
cuando corre asi -- medida en -1,3 min de desfase respecto al mediodia solar,
dentro de tolerancia. run-simulation -ts:hour, con un MET de paso real
sub-horario, agrega de forma nativa por HORA REAL de la marca (las 4 filas
cuarto-horarias que caen en cada hora) y centra bien la posicion solar de esa
agregacion. Para reconstruir la resolucion cuarto-horaria sin perder ese buen
centrado, cada fase P (0, 15, 30, 45) usa una copia del CSV con TODA la linea de
tiempo desplazada -P minutos (escribir_csv_desplazado): al agregar por hora REAL
de esa linea desplazada, cada "hora" recoge las 4 medidas cuarto-horarias
[P, P+60) de verdad -- confirmado sobre datos reales (ver verificacion del
2026-09-17): la ventana de cada fase empieza exactamente 15 min despues que la
anterior (fase 0: 08:00-08:45, fase 15: 08:15-09:00, fase 30: 08:30-09:15, fase
45: 08:45-09:30, las 4 con sus 4 marcas reales correctas). Cada fase, simulada
por separado con el MEF real, sale tan bien centrada como el camino directo
(-1,1 / +0,3 / -0,6 / -1,2 min medidos para FRA); combinadas dan -1,0 min.

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
        -> por cada fase (minuto distinto que traiga --csv) escribe una copia de
           --csv con la linea de tiempo desplazada a esa fase, ejecuta un
           convert-meteo + run-simulation -ts:hour DIRECTO (MEF real, sin
           modificar) por fase, y combina los CSV de resultado -- intercalados
           por fecha real -- en --out. Si cualquier fase falla se aborta TODO (no
           se deja un --out a medias): mejor reintentar en el siguiente ciclo que
           dejar una serie con huecos sin que se note. Codigo de salida 0/1.

Este script es DELIBERADAMENTE independiente de auto_run.bat en lo que hace: solo
importa de timeshift.py los lectores/escritores ya probados de Excel/MEF/CSV
(nada de timeshift.py se modifica ni se reescribe aqui), asi que si el
procedimiento pseudo-subhorario fallara por algo imprevisto, el camino de siempre
(subhour / hour directo) sigue intacto y no se ve afectado.

DESPLAZAMIENTO DE FASE (escribir_csv_desplazado): a cada marca del CSV se le
resta P minutos (mismo mecanismo, y mismo parsear_fecha/rehacer_fecha, que usa
timeshift.py para corregir horas enteras -- aqui a granularidad de minutos). El
-imt "base" que ya traiga la planta (T08_time_shifts, minutos sueltos del SCADA)
se sigue pasando tal cual a CADA fase: es un concepto distinto (desfase propio
del SCADA, no el centrado de la agregacion horaria) y SI funciona con normalidad
en el camino directo/real-MeasureStep que usa esta tecnica -- a diferencia del
-imt de centrado de la tecnica antigua, que resulto inutil.

NORMALIZACION DE LA MARCA DE SALIDA: run-simulation -ts:hour escribe SIEMPRE
':00' en la columna 'date' del CSV de resultado, con independencia del minuto
real de la marca de entrada (las 4 fases salen las cuatro etiquetadas ':00', con
valores DISTINTOS entre si: la agregacion en si SI usa las marcas reales de cada
fase, via el desplazamiento; solo la etiqueta de fecha de salida se normaliza).
Por eso combinar_resultados() le suma la fase a la fecha de salida ANTES de
ordenar/combinar (funcion _con_minuto), restaurando la hora de calendario real:
es exactamente el paso SetMinInCSVRes/offset_time_in_CSV del script de
referencia de PVsyst. Sin este paso las N fases se apilarian en la misma marca
en vez de intercalarse. La reescala de energia de cada fila (factor_energia =
paso/60, ver _escalar_fila) sigue exactamente igual que en la tecnica anterior:
cada fila de una fase sigue siendo, en el fondo, una MEDIA horaria (no una
muestra instantanea de `paso` minutos), asi que hay que repartir esa energia
entre las N fases para no contarla N veces.
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
def fases_de_marcas(marcas) -> list[int]:
    """Fases (minutos de desplazamiento) a simular: los minutos que aparecen DE
    VERDAD en los datos, no el `paso` declarado en la MEF -- da igual que el CSV
    sea de 15, 10, 20 o 5 minutos, o que falten muestras. Cada valor de minuto
    distinto en la columna de fecha es una fase.
    """
    return sorted({m.valor.minute for m in marcas})


def escribir_csv_desplazado(lineas: list[str], fmt: dict, fase_min: int, destino: Path) -> int:
    """Copia del CSV con TODA la linea de tiempo desplazada -fase_min minutos.

    Es la pieza central de la tecnica por fases (ver docstring del modulo):
    run-simulation -ts:hour agrega de forma nativa por HORA REAL de la marca
    (agrupa las filas sub-horarias que caen en cada hora del reloj). Desplazar
    TODAS las marcas -fase_min minutos antes de convertir hace que esa
    agregacion nativa recoja, para cada "hora" de la linea desplazada, las
    muestras reales de la ventana [fase_min, fase_min+60) -- confirmado sobre
    datos reales el 2026-09-17: la ventana de cada fase empieza exactamente
    fase_min minutos mas tarde que la de fase 0, con las mismas 4 marcas reales
    que le corresponden.

    Reutiliza parsear_fecha/rehacer_fecha de timeshift.py (mismo mecanismo, a
    granularidad de minutos, que usa timeshift.py para corregir horas enteras):
    conserva exactamente la forma textual original de cada marca. Devuelve el
    numero de filas desplazadas.
    """
    sep, col, orden = fmt["separador"], fmt["campo_fecha"], fmt["orden_fecha"]
    cabecera = lineas[: fmt["cabecera"]]
    nuevas = list(cabecera)
    n = 0
    for linea in lineas[fmt["cabecera"]:]:
        if not linea.strip():
            nuevas.append(linea)
            continue
        cuerpo = linea.rstrip("\r\n")
        term = linea[len(cuerpo):]
        trozos = cuerpo.split(sep)
        if len(trozos) < col:
            nuevas.append(linea)
            continue
        valor = parsear_fecha(trozos[col - 1], orden)
        if valor is None:
            nuevas.append(linea)
            continue
        nuevo = valor - dt.timedelta(minutes=fase_min)
        trozos[col - 1] = rehacer_fecha(trozos[col - 1], nuevo, orden)
        nuevas.append(sep.join(trozos) + term)
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
    real del .MET de entrada -- las N fases de un CSV cuarto-horario salen todas
    etiquetadas ':00' (con valores distintos entre si: la agregacion en si SI usa
    las marcas reales, va en el propio CSV desplazado de cada fase -- ver
    escribir_csv_desplazado; solo la etiqueta de fecha de salida se pierde). Sin
    este paso, la recombinacion de mas abajo apilaria las N fases en la misma
    marca en vez de intercalarlas. Es exactamente el paso SetMinInCSVRes/
    offset_time_in_CSV del script de referencia de PVsyst (ver docstring del
    modulo): sumar la fase a la fecha de salida ANTES de combinar.
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

    fases = fases_de_marcas(marcas)
    log.append(f"CSV: {csv.name}  {len(marcas):,} filas"
               + (f"  ({ilegibles} lineas ilegibles)" if ilegibles else ""))
    log.append(f"fases (minutos distintos en la marca): {fases}")
    if len(fases) < 2:
        log.append(f"aviso: solo se ha visto un minuto ({fases[0]}) en el CSV; "
                   f"el resultado equivale a -ts:hour directo")

    try:
        imt_base = int(args.imt)
    except (TypeError, ValueError):
        imt_base = 0
    if not (-30 <= imt_base <= 30):
        return fallar(f"-imt base={imt_base} fuera de rango [-30,30]. Revisa el "
                      f"time_shift de {planta} en T08_time_shifts.")
    imt_arg = [f"-imt:{imt_base}"] if imt_base != 0 else []

    sfi_arg = []
    if args.sfi and Path(args.sfi).is_file():
        sfi_arg = [f"-isf:{args.sfi}"]

    base_tmp = Path(tempfile.gettempdir()) / CARPETA_TMP
    base_tmp.mkdir(parents=True, exist_ok=True)
    tmp_dir = Path(tempfile.mkdtemp(prefix=f"{planta}_", dir=str(base_tmp)))

    resultados: list[tuple[Path, int]] = []
    try:
        for fase in fases:
            etiqueta_fase = f"fase{fase:02d}"
            csv_fase = tmp_dir / f"{planta}_{etiqueta_fase}.csv"
            met_fase = ws / "Meteo" / f"{planta}_pseudo_{etiqueta_fase}.MET"
            res_fase = tmp_dir / f"{planta}_{etiqueta_fase}_result.csv"

            n_desplazadas = escribir_csv_desplazado(lineas, fmt, fase, csv_fase)

            # MEF REAL, sin modificar (a diferencia de la tecnica antigua, que
            # forzaba MeasureStep=60): run-simulation -ts:hour agrega de forma
            # nativa las filas sub-horarias que caen en cada hora de la linea
            # desplazada -- es el mismo mecanismo que ya usan con exito PL1/PL2
            # (aggregate_by_hour=true) y FRA en directo (ver docstring).
            rc = _ejecutar_cli(
                [str(cli), "convert-meteo", f"-icf:{csv_fase}", f"-imf:{mef}",
                 f"-isf:{sit}", f"-omf:{met_fase}", *imt_arg],
                log, f"convert-meteo {etiqueta_fase}",
            )
            if rc != 0 or not met_fase.is_file():
                return fallar(f"convert-meteo fallo en la fase {etiqueta_fase} "
                              f"({n_desplazadas} filas desplazadas, imt {imt_base:+d})")

            rc = _ejecutar_cli(
                [str(cli), "run-simulation", f"-w:{ws}", f"-p:{args.prj}",
                 f"-v:{args.variant}", "-ts:hour", f"-s:{sit}", f"-imf:{met_fase}",
                 *sfi_arg, f"-ocf:{res_fase}", "-odc", "-rl:en"],
                log, f"run-simulation {etiqueta_fase}",
            )
            try:
                met_fase.unlink()
            except OSError:
                pass
            if rc != 0 or not res_fase.is_file():
                return fallar(f"run-simulation fallo en la fase {etiqueta_fase} "
                              f"({n_desplazadas} filas desplazadas)")

            log.append(f"fase {etiqueta_fase}: {n_desplazadas} filas desplazadas -{fase} min, "
                       f"imt {imt_base:+d} -> OK")
            resultados.append((res_fase, fase))

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
    print(f"{PREF}[PSEUDO-SUBHOUR OK] {planta}: {len(fases)} fase(s) "
          f"(minutos {', '.join(f'{f:02d}' for f in fases)}), {n_filas:,} filas combinadas.")
    if args.verbose:
        for linea in log:
            print(f"{PREF}  {linea}")
    return 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Procedimiento pseudo-subhorario: N simulaciones -ts:hour "
                    "directas (MEF real) sobre el CSV raw desplazado a cada fase, "
                    "y recombinacion de los CSV de resultado.")
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
