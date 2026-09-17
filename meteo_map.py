"""
Diagnostico de mapeo MEF <-> columnas del CSV para cada convert-meteo.

Se invoca desde auto_run.bat justo ANTES de llamar a "PVsystCLI convert-meteo",
mientras el CSV de entrada todavia existe (el .bat lo borra al terminar la
simulacion). Lee el fichero de formato MEF (pvMeteoFormat) y la cabecera del CSV
raw y escribe en el log, por cada corrida:

  - Que variables PVsyst usa el MEF (VarIdent) y a que columna del CSV mapea cada
    una (por nombre de columna: la primera fila del CSV raw son los nombres).
  - Que columna(s) del CSV NO mapea el MEF (columnas ignoradas por convert-meteo).
  - Avisos de mapeo invalido (VarIdent que apunta a una columna inexistente o a
    una cabecera vacia).

Es SOLO diagnostico: imprime a stdout (que auto_run.bat redirige al log) y nunca
aborta la corrida. Cualquier error se reporta como una linea de aviso.

Uso:
    python meteo_map.py <ruta_MEF> <ruta_CSV>

Salida en ASCII (sin acentos) para viajar limpia por el log cp1252 del .bat.
"""
from __future__ import annotations

import sys
from pathlib import Path

# --- Prefijo de indentacion para alinear con el resto de lineas del .bat ---
PREF = "    "


def _leer_texto(ruta: Path) -> str:
    """Lee un fichero de texto probando codificaciones tipicas de PVsyst/exports."""
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return ruta.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    # Ultimo recurso: bytes con reemplazo
    return ruta.read_bytes().decode("latin-1", errors="replace")


def _parse_separador(valor: str) -> tuple[str, str]:
    """Convierte el campo Separ del MEF en (caracter, nombre legible).

    PVsyst lo guarda como codigo hex con prefijo '$' (p.ej. $002C = coma,
    $0009 = tabulador, $003B = punto y coma). Algunos MEF lo guardan literal.
    """
    valor = valor.strip()
    nombres = {",": "coma", ";": "punto y coma", "\t": "tabulador", " ": "espacio", "|": "barra"}
    car = ","
    if valor.startswith("$"):
        try:
            car = chr(int(valor[1:], 16))
        except ValueError:
            car = ","
    elif valor.lower() in ("tab", "tabulador"):
        car = "\t"
    elif valor:
        car = valor[0]
    return car, nombres.get(car, repr(car))


def _parse_mef(ruta: Path) -> dict:
    """Extrae de un MEF: separador, campos de fecha/hora y las variables ASCII."""
    sep_char, sep_nombre = ",", "coma"
    campos_fecha: set[int] = set()
    variables: list[dict] = []
    actual: dict | None = None

    for cruda in _leer_texto(ruta).splitlines():
        linea = cruda.strip()
        if "=" not in linea and not linea.startswith("End of TVarASCII"):
            continue

        if linea.startswith("Separ="):
            sep_char, sep_nombre = _parse_separador(linea.split("=", 1)[1])
        elif linea.startswith("NoFieldDate="):
            valor = linea.split("=", 1)[1]
            for tok in valor.split(","):
                tok = tok.strip()
                if tok.isdigit() and int(tok) > 0:
                    campos_fecha.add(int(tok))
        elif linea.startswith("VarASCII="):
            actual = {"ident": None, "tipo": None, "nofield": None, "unit": None}
        elif linea.startswith("End of TVarASCII"):
            if actual and actual.get("nofield"):
                variables.append(actual)
            actual = None
        elif actual is not None:
            if linea.startswith("VarIdent="):
                actual["ident"] = linea.split("=", 1)[1].strip()
            elif linea.startswith("VarType="):
                actual["tipo"] = linea.split("=", 1)[1].strip()
            elif linea.startswith("UnitId="):
                actual["unit"] = linea.split("=", 1)[1].strip()
            elif linea.startswith("NoField="):
                num = linea.split("=", 1)[1].strip()
                actual["nofield"] = int(num) if num.isdigit() else None

    return {
        "sep_char": sep_char,
        "sep_nombre": sep_nombre,
        "campos_fecha": campos_fecha,
        "variables": variables,
    }


def _leer_cabecera(ruta: Path, sep: str) -> list[str]:
    """Devuelve los nombres de columna de la primera fila del CSV raw."""
    texto = _leer_texto(ruta)
    primera = ""
    for cruda in texto.splitlines():
        if cruda.strip() != "":
            primera = cruda
            break
    columnas = [c.strip().strip('"').strip("'") for c in primera.split(sep)]
    # Quitar posible ultima columna vacia por separador final
    while columnas and columnas[-1] == "":
        columnas.pop()
    return columnas


def _nombre_columna(cols: list[str], nofield: int) -> str | None:
    """Nombre (1-based) de la columna nofield, o None si esta fuera de rango."""
    if 1 <= nofield <= len(cols):
        return cols[nofield - 1]
    return None


def analizar(mef_path: str, csv_path: str) -> int:
    mef = Path(mef_path)
    csv = Path(csv_path)

    print(f"{PREF}[MAPEO MEF] {mef.name}  <->  {csv.name}")

    if not mef.exists():
        print(f"{PREF}  [AVISO] No existe el MEF: {mef}")
        return 0
    if not csv.exists():
        print(f"{PREF}  [AVISO] No existe el CSV: {csv}")
        return 0

    info = _parse_mef(mef)
    cols = _leer_cabecera(csv, info["sep_char"])

    print(f"{PREF}  Separador: {info['sep_nombre']}   Cabecera CSV: {len(cols)} columna(s)")

    if not info["variables"]:
        print(f"{PREF}  [AVISO] El MEF no declara variables ASCII (VarASCIIList vacia).")

    # --- Variables PVsyst y su columna ---
    usados: set[int] = set(info["campos_fecha"])
    print(f"{PREF}  Variables PVsyst mapeadas (VarIdent <- columna CSV):")
    for v in info["variables"]:
        ident = v.get("ident") or "?"
        tipo = v.get("tipo") or "?"
        unit = v.get("unit") or "?"
        nf = v.get("nofield")
        etiqueta = f"{ident} ({tipo}, {unit})"
        if nf is None:
            print(f"{PREF}    {etiqueta}: sin NoField definido -> NO mapea")
            continue
        usados.add(nf)
        nombre = _nombre_columna(cols, nf)
        if nombre is None:
            print(f"{PREF}    [!] {etiqueta} -> col {nf}, pero el CSV solo tiene "
                  f"{len(cols)} columna(s): NO mapea")
        elif nombre == "":
            print(f"{PREF}    [!] {etiqueta} -> col {nf} con cabecera VACIA: NO mapea")
        else:
            print(f"{PREF}    {etiqueta} <- col {nf} '{nombre}'")

    # --- Campo fecha/hora ---
    if info["campos_fecha"]:
        etiquetas = []
        for nf in sorted(info["campos_fecha"]):
            nombre = _nombre_columna(cols, nf)
            etiquetas.append(f"col {nf} '{nombre}'" if nombre is not None else f"col {nf} (fuera de rango)")
        print(f"{PREF}  Campo(s) fecha/hora: {', '.join(etiquetas)}")

    # --- Columnas del CSV que el MEF NO mapea ---
    no_mapeadas = [(i, cols[i - 1]) for i in range(1, len(cols) + 1) if i not in usados]
    if no_mapeadas:
        print(f"{PREF}  Columnas del CSV NO mapeadas por el MEF (ignoradas por convert-meteo):")
        for i, nombre in no_mapeadas:
            print(f"{PREF}    col {i} '{nombre}'")
    else:
        print(f"{PREF}  Todas las columnas del CSV estan mapeadas por el MEF.")

    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(f"{PREF}[MAPEO MEF] [AVISO] uso: python meteo_map.py <MEF> <CSV>")
        return 0
    try:
        return analizar(argv[1], argv[2])
    except Exception as e:  # diagnostico: nunca abortamos la corrida
        print(f"{PREF}[MAPEO MEF] [AVISO] no se pudo analizar el mapeo: {e}")
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
