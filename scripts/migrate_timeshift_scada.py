"""Mueve el time-shift de T08 del lado PVsyst al lado SCADA.

Antes: csv_ingest desplazaba las fechas de proc_pvsyst (redondeando a 15 min),
       lo que sacaba a PVsyst de su rejilla horaria y rompia el
       merge(on='Date', how='inner') de pr_runner cuando el desfase no era
       multiplo de 60 (caso PL1: 72 -> 75 min -> 0 filas casadas).

Ahora:  proc_pvsyst guarda las fechas tal como las entrega el CSV (:00) y el
        desfase se aplica en pr_runner sobre el SCADA de 15 min, redondeado a su
        resolucion nativa y ANTES de agregar a hora. traceability_export replica
        el mismo desplazamiento para que el Excel cuadre con pr_runner.

Idempotente: si un notebook ya esta migrado, se salta.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FAB = ROOT / '_fab_export'


# --------------------------------------------------------------------------
# Bloque comun: lector de reglas T08 + calculo del desfase por fila.
# Se inyecta en pr_runner y en traceability_export (no comparten modulo, igual
# que ya pasa con los lectores de config).
# --------------------------------------------------------------------------
def timeshift_helpers(reader: str) -> str:
    return f'''

# ---------------------------------------------------------
# Time-shift T08 — se aplica al SCADA, ANTES de agrupar
# ---------------------------------------------------------
# `time_shift` de T08_time_shifts son los minutos que la conversion PVsyst
# adelanto el meteo antes de simular (auto_run.bat + scripts/timeshift.py en el
# PC de PVsyst). PVsyst devuelve su CSV en la rejilla horaria limpia (:00), asi
# que el desfase NO se toca en proc_pvsyst: se aplica aqui sobre las fechas del
# SCADA, que es la serie fina, y ANTES de agregar a hora.
#
# Se redondea a la resolucion NATIVA del raw SCADA (15 min en estas plantas):
# con un desfase que no cae en esa rejilla, el resample posterior mandaria unas
# filas al bucket de arriba y otras al de abajo. Redondeando a la rejilla el
# agrupado es determinista y el desfase sobrevive entero al bucket horario (los
# 75 min de PL1 siguen siendo 75, no 60).
#
# OJO: un desfase que no sea multiplo de 60 (p.ej. 75) deja buckets horarios
# desparejos, de 3 o 4 intervalos de 15 min. No falsea el PR porque la
# agregacion es por MEDIA (potencia), no por suma.
#
# Semantica de periodos (la misma que documenta T08):
#   - Lo que no cubre ningun periodo queda a 0.
#   - end_date es INCLUSIVO, y las costuras caen a las DST_SEAM_HOUR del dia
#     indicado: el reloj en la UE cambia a las 02:00/03:00 locales, no a
#     medianoche, asi que cortar a dia completo desalinearia la madrugada.
#   - Puede haber VARIOS periodos por planta; si se solapan gana el de MAS
#     ABAJO en la tabla (las reglas se aplican en orden).
#   - Un 0 explicito es una regla valida: anula un periodo anterior solapado.
#   - Fecha vacia = sin limite por ese lado.
DST_SEAM_HOUR = 2


def t08_rules(plant_code):
    """T08_time_shifts -> [(start, end, minutos)] de la planta, EN EL ORDEN DE LA TABLA."""
    rules = []
    try:
        df = {reader}
        df.columns = [str(c).strip().lower() for c in df.columns]
        sub = df[df['plant_code'].astype(str).str.strip().str.upper()
                 == str(plant_code).strip().upper()]
        for _, r in sub.iterrows():
            try:
                raw = float(r.get('time_shift'))
            except (TypeError, ValueError):
                continue          # celda vacia o no numerica: no es una regla
            if pd.isna(raw):
                continue
            start = pd.to_datetime(r.get('start_date'), errors='coerce')
            end   = pd.to_datetime(r.get('end_date'),   errors='coerce')
            rules.append((None if pd.isna(start) else start,
                          None if pd.isna(end)   else end,
                          raw))
    except Exception as e:
        print(f'  [time_shift] no se pudieron leer reglas T08 para {{plant_code}}: {{e}}')
    return rules


def scada_time_shift(dates, plant_code, scada_res):
    """Minutos a SUMAR a cada fecha del SCADA para llevarla a la escala de PVsyst.

    `scada_res` es la resolucion nativa del raw SCADA y define la rejilla a la
    que se redondea el desfase. Devuelve una Serie int64 alineada con `dates`
    (0 en las filas que no cubre ninguna regla).
    """
    step = max(1, int(round(pd.Timedelta(scada_res).total_seconds() / 60)))
    out  = pd.Series(0, index=dates.index, dtype='int64')
    seam = pd.Timedelta(hours=DST_SEAM_HOUR)
    for start, end, raw in t08_rules(plant_code):
        mins = int(round(raw / step)) * step
        mask = pd.Series(True, index=dates.index)
        if start is not None:
            mask &= dates > pd.Timestamp(start).normalize() + seam
        if end is not None:
            mask &= dates <= pd.Timestamp(end).normalize() + seam
        out.loc[mask] = mins
    return out
'''


PR_RUNNER_APPLY = '''

# Time-shift T08: se aplica AQUI, sobre la serie nativa del SCADA y ANTES de
# agrupar a hora (ver scada_time_shift). PVsyst se queda tal como lo entrega el
# CSV, en la rejilla horaria limpia.
_shift_min = scada_time_shift(scada['Date'], plant_code, scada_res)
scada['Date'] = scada['Date'] + pd.to_timedelta(_shift_min, unit='m')
scada = scada.sort_values('Date').reset_index(drop=True)
_tramos = sorted({int(x) for x in _shift_min.unique()})
if any(_t != 0 for _t in _tramos):
    _n = int((_shift_min != 0).sum())
    print(f'Time-shift T08: SCADA desplazado {_tramos} min (rejilla {scada_res}) '
          f'en {_n:,}/{len(scada):,} filas')
else:
    print('Time-shift T08: sin desfase declarado para esta planta/periodo')'''


# --------------------------------------------------------------------------
# Utilidades de parcheo de notebooks
# --------------------------------------------------------------------------
def load(nb_name):
    path = FAB / f'{nb_name}.Notebook' / 'notebook-content.ipynb'
    return path, json.loads(path.read_text(encoding='utf-8'))


def save(path, nb):
    txt = json.dumps(nb, indent=2, ensure_ascii=False) + '\n'
    path.write_text(txt, encoding='utf-8', newline='\n')


def cell_by_id(nb, cell_id):
    for c in nb['cells']:
        if c.get('id') == cell_id:
            return c
    raise KeyError(f'no existe la celda {cell_id}')


def src(cell):
    return ''.join(cell['source'])


def set_src(cell, text):
    lines = text.split('\n')
    cell['source'] = [ln + '\n' for ln in lines[:-1]] + ([lines[-1]] if lines[-1] else [])


def replace_in(cell, old, new, label):
    s = src(cell)
    if old not in s:
        raise AssertionError(f'{label}: no encuentro el fragmento a sustituir')
    if s.count(old) != 1:
        raise AssertionError(f'{label}: el fragmento aparece {s.count(old)} veces')
    set_src(cell, s.replace(old, new))


def append_to(cell, text):
    set_src(cell, src(cell).rstrip('\n') + '\n' + text.lstrip('\n'))


# --------------------------------------------------------------------------
# 1) pr_runner — helpers en la celda de config, aplicacion tras cargar SCADA
# --------------------------------------------------------------------------
def patch_pr_runner():
    path, nb = load('pr_runner')
    cfg_cell  = cell_by_id(nb, '42e11160-270f-4a7a-b702-deea911846ff')
    load_cell = cell_by_id(nb, '1f5ce780-fa7c-47e6-839b-53955a5dfd57')

    if 'scada_time_shift' in src(cfg_cell):
        print('pr_runner: ya migrado, se salta')
        return False

    append_to(cfg_cell, timeshift_helpers(
        "_read_cfg_table('08_Time_Shifts', 'T08_time_shifts')"))
    append_to(load_cell, PR_RUNNER_APPLY)
    save(path, nb)
    print('pr_runner: helpers T08 + desplazamiento del SCADA antes de agrupar')
    return True


# --------------------------------------------------------------------------
# 2) csv_ingest — deja de desplazar proc_pvsyst
# --------------------------------------------------------------------------
def patch_csv_ingest():
    path, nb = load('csv_ingest')
    doc_cell   = cell_by_id(nb, '5f5c3129-8c1b-41ec-94de-c43cac61e3de')
    param_cell = cell_by_id(nb, '92a4f0b4-c9c0-46d7-8cfd-95efdb7bc4dd')
    helper     = cell_by_id(nb, '5b17193d-96df-4480-875a-0e6fe1772dcf')
    main       = cell_by_id(nb, '6a7d9705-f59a-4663-87fc-4fe060e9aae1')

    if 'revert_pvsyst_time_shift' not in src(helper):
        print('csv_ingest: ya migrado, se salta')
        return False

    # 2a) doc de cabecera
    replace_in(doc_cell,
        "**Time-shift**: la conversión PVsyst desplaza el meteo antes de simular, con el\n"
        "desfase de `T08_time_shifts` (ver `scripts/timeshift.py` en el PC de PVsyst): las horas\n"
        "enteras corrigiendo las fechas del CSV raw en los cambios de hora, y los minutos sueltos\n"
        "con el `-imt` del CLI. Aquí se **deshacen las dos cosas**, para que las fechas vuelvan a\n"
        "la escala de tiempo del SCADA y el PR compare hora contra hora.",
        "**Time-shift**: aquí NO se toca. Las fechas de PVsyst se guardan tal como vienen del\n"
        "CSV (rejilla horaria limpia, `:00`). El desfase de `T08_time_shifts` se aplica en\n"
        "`pr_runner`, sobre el SCADA de 15 min y antes de agregar a hora, redondeado a la\n"
        "resolución nativa del SCADA. Desplazar PVsyst aquí lo sacaba de su rejilla y dejaba\n"
        "sin casar el `merge(on='Date')` del cálculo cuando el desfase no era múltiplo de 60.",
        'csv_ingest/doc')

    # 2b) parametro obsoleto
    replace_in(param_cell,
        "time_shift_min = 0    # OVERRIDE manual, en minutos. El desfase normal sale de\n"
        "                      # T08_time_shifts: es el que la conversion PVsyst aplico\n"
        "                      # (horas corrigiendo el CSV raw + minutos con el -imt) y\n"
        "                      # que aqui se DESHACE. Este escalar solo se usa si la\n"
        "                      # planta NO tiene reglas en T08, y solo cubre los minutos\n"
        "                      # del -imt (compat. legacy).",
        "time_shift_min = 0    # OBSOLETO: se ignora. El desfase de T08_time_shifts se\n"
        "                      # aplica en pr_runner sobre el SCADA. Se mantiene el\n"
        "                      # parametro para no romper llamadas que aun lo pasen.",
        'csv_ingest/param')

    # 2c) fuera toda la maquinaria de shift; la columna se queda a 0 por esquema
    # revert_pvsyst_time_shift y sus auxiliares son lo ultimo de la celda, asi que
    # basta con cortar desde la primera de ellas.
    s = src(helper)
    set_src(helper, s[:s.index('def _pvsyst_shift_rules(plant_code):')].rstrip('\n') + '\n')

    replace_in(helper,
        "    canonical = {'plant_code', 'Date', 'GHI', 'DHI', 'T_AMB', 'ALB', 'POA', 'E_Grid',\n"
        "                 'time_shift', 'source_file', 'ingested_at'}",
        "    # El desfase T08 ya NO se aplica aqui: las fechas van tal como vienen del CSV\n"
        "    # (rejilla horaria limpia) y el desplazamiento se hace en pr_runner sobre el\n"
        "    # SCADA de 15 min, antes de agrupar. La columna se mantiene a 0 para no\n"
        "    # cambiar el esquema de proc_pvsyst (int64).\n"
        "    df['time_shift'] = 0\n"
        "    canonical = {'plant_code', 'Date', 'GHI', 'DHI', 'T_AMB', 'ALB', 'POA', 'E_Grid',\n"
        "                 'time_shift', 'source_file', 'ingested_at'}",
        'csv_ingest/write_proc')

    # 2d) sitio de llamada
    replace_in(main,
        "            df_clean = normalize_pvsyst(df_raw)\n"
        "            # deshace el desfase que la conversion PVsyst aplico via MEF/-imt (T08)\n"
        "            df_clean = revert_pvsyst_time_shift(df_clean, plant, manual_min=time_shift_min)\n",
        "            df_clean = normalize_pvsyst(df_raw)\n",
        'csv_ingest/main')

    save(path, nb)
    print('csv_ingest: proc_pvsyst deja de desplazarse (time_shift = 0)')
    return True


# --------------------------------------------------------------------------
# 3) traceability_export — replica el mismo desplazamiento
# --------------------------------------------------------------------------
def patch_traceability():
    path, nb = load('traceability_export')
    cfg_cell   = cell_by_id(nb, '45673418-d1fe-4511-9fca-be43d11c3672')
    build_cell = cell_by_id(nb, 'd8305171-b820-491f-9bb6-04444e028ce5')

    if 'scada_time_shift' in src(cfg_cell):
        print('traceability_export: ya migrado, se salta')
        return False

    append_to(cfg_cell, timeshift_helpers(
        "_read_sheet('08_Time_Shifts', 'T08_time_shifts')"))

    # 3a) los buckets se construyen sobre la fecha YA desplazada, igual que pr_runner
    replace_in(build_cell,
        "    _bkeys = scada_proc_df['Date'].dt.floor(_freq)\n"
        "\n"
        "    # contiguous buckets by REAL date (no shift): [row_03_start, row_03_end]\n"
        "    _buckets = []\n"
        "    _prev = None\n"
        "    for _off, _bk in enumerate(_bkeys):\n"
        "        _pr = data_start + _off\n"
        "        if _prev is None or _bk != _prev[0]:\n"
        "            _buckets.append([_bk, _pr, _pr]); _prev = _buckets[-1]\n"
        "        else:\n"
        "            _prev[2] = _pr\n",
        "    # Mismo time-shift que pr_runner: se desplaza el SCADA (serie nativa) ANTES de\n"
        "    # agrupar, redondeado a su resolucion. proc_pvsyst va sin tocar, en su :00.\n"
        "    _ts_min = scada_time_shift(scada_proc_df['Date'], plant_code, _scada_res)\n"
        "    _bkeys  = (scada_proc_df['Date'] + pd.to_timedelta(_ts_min, unit='m')).dt.floor(_freq)\n"
        "\n"
        "    # contiguous buckets: [bucket_key, row_03_start, row_03_end, shift_min]\n"
        "    _buckets = []\n"
        "    _prev = None\n"
        "    for _off, _bk in enumerate(_bkeys):\n"
        "        _pr = data_start + _off\n"
        "        if _prev is None or _bk != _prev[0]:\n"
        "            _buckets.append([_bk, _pr, _pr, int(_ts_min.iloc[_off])]); _prev = _buckets[-1]\n"
        "        else:\n"
        "            _prev[2] = _pr\n",
        'trace/buckets')

    # 3b) la columna Date del comparativo ya lleva el desfase, asi que las
    #     busquedas por hora contra tbl_pv y el HOUR() cuadran con pr_runner
    replace_in(build_cell,
        "    for _bk, _r0, _r1 in _buckets:\n"
        "        _A = f\"A{r_cmp}\"\n"
        "        # Date = date from 03 + time_shift/24  (dynamic)\n"
        "        ws_cmp.cell(row=r_cmp, column=1,\n"
        "                    value=f\"='{_psheet}'!{_date_l}{_r0}\").number_format = 'yyyy-mm-dd hh:mm'\n",
        "    for _bk, _r0, _r1, _sh in _buckets:\n"
        "        _A = f\"A{r_cmp}\"\n"
        "        # Date = fecha de 03 + el time-shift T08 del tramo (en dias para Excel).\n"
        "        # Con esto $A esta en la escala de PVsyst y las busquedas por hora de\n"
        "        # abajo (INT($A*24), HOUR($A)) cuadran con lo que hace pr_runner.\n"
        "        _sh_txt = '' if _sh == 0 else (f'+{_sh}/1440' if _sh > 0 else f'-{abs(_sh)}/1440')\n"
        "        ws_cmp.cell(row=r_cmp, column=1,\n"
        "                    value=f\"='{_psheet}'!{_date_l}{_r0}{_sh_txt}\").number_format = 'yyyy-mm-dd hh:mm'\n",
        'trace/date-formula')

    # 3c) comentarios que hablaban de un scada_proc ya desplazado
    replace_in(build_cell,
        "    # contiguous range of rows in 03 (scada_proc is sorted by Date, already time_shifted).",
        "    # contiguous range of rows in 03 (scada_proc is sorted by Date, WITHOUT the T08\n"
        "    # shift: the shift is added below, when building each comparison bucket).",
        'trace/comment-1')

    replace_in(build_cell,
        "        # Expected energy = PVsyst E_Grid for the hour (by the already-shifted date) * dt_h  (dynamic)",
        "        # Expected energy = PVsyst E_Grid for the hour (matched on the shifted $A) * dt_h  (dynamic)",
        'trace/comment-2')

    replace_in(build_cell,
        "        # Expected POA = PVsyst POA for the hour (shifted date)  (dynamic)",
        "        # Expected POA = PVsyst POA for the hour (matched on the shifted $A)  (dynamic)",
        'trace/comment-3')

    replace_in(build_cell,
        "        # Hour of day (from the shifted date) for the hourly profile",
        "        # Hour of day (from the shifted $A) for the hourly profile",
        'trace/comment-4')

    save(path, nb)
    print('traceability_export: replica el time-shift del SCADA')
    return True


if __name__ == '__main__':
    changed = False
    for fn in (patch_pr_runner, patch_csv_ingest, patch_traceability):
        try:
            changed |= fn()
        except (AssertionError, KeyError) as e:
            print(f'FALLO en {fn.__name__}: {e}')
            sys.exit(1)
    print('\nOK' if changed else '\nNada que hacer')
