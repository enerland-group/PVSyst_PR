"""Corrige el SIGNO del time-shift T08 en pr_runner y traceability_export.

El comportamiento validado (csv_ingest hasta el commit d4bdf7f, FRA 121% -> 104,3%)
era `proc_pvsyst.Date = Date + time_shift`: los minutos de T08 se SUMAN al lado
PVsyst, o sea a la energia esperada y a la garantizada.

Al mover el desfase al SCADA (commit 6ec8e56) se dejo `scada.Date + shift`, que es
la correccion CONTRARIA: para FRA (180 min) desalineaba 6 h en vez de 0.

Este parche deja:
  1. El desfase se RESTA al SCADA (equivalente a sumarselo a PVsyst) y solo para
     que el bucket horario case; se aplica DESPUES de evaluar los criterios, para
     que el agrupado por dia siga en hora real.
  2. Tras el merge se devuelve la fecha a hora real (+shift), de modo que el
     desfase queda efectivamente aplicado a la esperada y a la garantizada, y
     todo lo que sale (dias, perfil horario, ts de intervalos) va en hora real.
  3. traceability_export replica exactamente lo mismo: la columna A del Excel va
     en hora real y las busquedas contra PVsyst se hacen sobre A - shift.

Idempotente: si un notebook ya esta parcheado, se salta.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FAB = ROOT / '_fab_export'

# --------------------------------------------------------------------------
# (viejo, nuevo) por notebook. `viejo` tiene que aparecer UNA vez.
# --------------------------------------------------------------------------

PR_RUNNER = [
    # 1) Cabecera del bloque: convenio de signo explicito.
    (
        "# `time_shift` de T08_time_shifts son los minutos que la conversion PVsyst\n"
        "# adelanto el meteo antes de simular (auto_run.bat + scripts/timeshift.py en el\n"
        "# PC de PVsyst). PVsyst devuelve su CSV en la rejilla horaria limpia (:00), asi\n"
        "# que el desfase NO se toca en proc_pvsyst: se aplica aqui sobre las fechas del\n"
        "# SCADA, que es la serie fina, y ANTES de agregar a hora.\n",

        "# `time_shift` de T08_time_shifts son los minutos que hay que SUMAR al lado\n"
        "# PVsyst, es decir a la energia esperada y a la garantizada. Es el convenio de\n"
        "# siempre: hasta que el desfase se movio al SCADA, csv_ingest hacia\n"
        "# `proc_pvsyst.Date = Date + time_shift` (asi se valido FRA, 121% -> 104,3%).\n"
        "#\n"
        "# Sumar X a PVsyst es lo mismo que RESTAR X al SCADA, y restarlo al SCADA es lo\n"
        "# que se hace aqui, porque el SCADA es la serie fina y el desfase (75 min de\n"
        "# PL1) no cabe en la rejilla horaria de PVsyst. Tras casar las dos series, en\n"
        "# compute_pr_test se devuelve la fecha a HORA REAL sumando el mismo desfase:\n"
        "# el resultado neto es el desplazamiento aplicado a esperada y garantizada.\n",
    ),
    # 2) Docstring de scada_time_shift.
    (
        "    \"\"\"Minutos a SUMAR a cada fecha del SCADA para llevarla a la escala de PVsyst.\n",
        "    \"\"\"Minutos de desfase de T08, con el signo de T08 (los que se le suman a PVsyst).\n"
        "\n"
        "    El llamante los RESTA a las fechas del SCADA, que es la operacion inversa y\n"
        "    equivalente, y los vuelve a sumar despues del merge para dejar el resultado\n"
        "    en hora real.\n",
    ),
    # 3) Aplicacion: ya no se desplaza aqui; solo se anota la columna.
    (
        "# Time-shift T08: se aplica AQUI, sobre la serie nativa del SCADA y ANTES de\n"
        "# agrupar a hora (ver scada_time_shift). PVsyst se queda tal como lo entrega el\n"
        "# CSV, en la rejilla horaria limpia.\n"
        "_shift_min = scada_time_shift(scada['Date'], plant_code, scada_res)\n"
        "scada['Date'] = scada['Date'] + pd.to_timedelta(_shift_min, unit='m')\n"
        "scada = scada.sort_values('Date').reset_index(drop=True)\n",

        "# Time-shift T08: aqui solo se ANOTA (columna _shift_min, en la rejilla nativa\n"
        "# del SCADA). El desplazamiento se aplica mas abajo, despues de evaluar los\n"
        "# criterios, para que el agrupado por dia de c8/c9 y los dias excluidos sigan\n"
        "# calculandose en hora real. PVsyst se queda tal como lo entrega el CSV.\n"
        "_shift_min = scada_time_shift(scada['Date'], plant_code, scada_res)\n"
        "scada['_shift_min'] = _shift_min.values\n",
    ),
    # 4) Textos del print (ya no se ha desplazado nada en ese punto).
    (
        "    print(f'Time-shift T08: SCADA desplazado {_tramos} min (rejilla {scada_res}) '\n"
        "          f'en {_n:,}/{len(scada):,} filas')\n",

        "    print(f'Time-shift T08: {_tramos} min a sumar a PVsyst (rejilla {scada_res}) '\n"
        "          f'en {_n:,}/{len(scada):,} filas')\n",
    ),
    # 5) aggregate_to_target: el desfase no se promedia.
    (
        "    for col in df.columns:\n"
        "        if col in {'c1','c2','c3','c4','c5','c6','c7','c8','c9','all_valid'}:\n"
        "            agg[col] = 'min'\n",

        "    for col in df.columns:\n"
        "        if col == '_shift_min':\n"
        "            agg[col] = 'first'   # el desfase del tramo, no un promedio\n"
        "        elif col in {'c1','c2','c3','c4','c5','c6','c7','c8','c9','all_valid'}:\n"
        "            agg[col] = 'min'\n",
    ),
    # 6) compute_pr_test: vuelta a hora real justo despues del merge.
    (
        "def compute_pr_test(scada_with_crit, pvsyst, cfg):\n"
        "    df = scada_with_crit.merge(pvsyst, on='Date', how='inner', suffixes=('', '_pv'))\n",

        "def compute_pr_test(scada_with_crit, pvsyst, cfg):\n"
        "    df = scada_with_crit.merge(pvsyst, on='Date', how='inner', suffixes=('', '_pv'))\n"
        "    # El SCADA venia desplazado -shift para casar el bucket con PVsyst; aqui se\n"
        "    # deshace y todo pasa a HORA REAL. Neto: el desfase queda aplicado a la\n"
        "    # esperada y a la garantizada (que es como se valido), y las fechas que salen\n"
        "    # -dias, perfil horario, ts de cada intervalo- son las del SCADA.\n"
        "    if '_shift_min' in df.columns:\n"
        "        df['Date'] = df['Date'] + pd.to_timedelta(df['_shift_min'].fillna(0), unit='m')\n"
        "        df = (df.drop(columns=['_shift_min'])\n"
        "                .sort_values('Date').reset_index(drop=True))\n",
    ),
    # 6b) Costura entre tramos T08: el salto de desfase no es inyectivo.
    (
        "    if '_shift_min' in df.columns:\n"
        "        df['Date'] = df['Date'] + pd.to_timedelta(df['_shift_min'].fillna(0), unit='m')\n"
        "        df = (df.drop(columns=['_shift_min'])\n"
        "                .sort_values('Date').reset_index(drop=True))\n",

        "    if '_shift_min' in df.columns:\n"
        "        df['Date'] = df['Date'] + pd.to_timedelta(df['_shift_min'].fillna(0), unit='m')\n"
        "        df = (df.drop(columns=['_shift_min'])\n"
        "                .sort_values('Date').reset_index(drop=True))\n"
        "        # En la costura entre dos tramos de T08 (p.ej. el arranque de la regla de\n"
        "        # verano) el desfase da un salto, y volver a hora real deja de ser\n"
        "        # inyectivo: la hora del solape aparece dos veces. Es el mismo solape que\n"
        "        # en un cambio de hora, cae de madrugada, y hay que quitarlo o el MERGE de\n"
        "        # pr_results falla (DELTA_MULTIPLE_SOURCE_ROW_MATCHING_TARGET_ROW).\n"
        "        _dup = int(df['Date'].duplicated().sum())\n"
        "        if _dup:\n"
        "            df = df.drop_duplicates(subset='Date', keep='first').reset_index(drop=True)\n"
        "            print(f'  [time_shift] costura de tramo T08: {_dup} intervalo(s) '\n"
        "                  f'solapado(s) descartado(s)')\n",
    ),
    # 7) Aplicacion del desfase tras evaluar criterios.
    (
        "scada_with_crit, audit = evaluate_criteria(scada, cfg)\n",

        "scada_with_crit, audit = evaluate_criteria(scada, cfg)\n"
        "# Desfase T08: se RESTA al SCADA (= sumarselo a PVsyst) una vez evaluados los\n"
        "# criterios, y solo para que el bucket horario case con PVsyst. compute_pr_test\n"
        "# devuelve las fechas a hora real despues del merge.\n"
        "if '_shift_min' in scada_with_crit.columns:\n"
        "    scada_with_crit['Date'] = (scada_with_crit['Date']\n"
        "                               - pd.to_timedelta(scada_with_crit['_shift_min'], unit='m'))\n"
        "    scada_with_crit = scada_with_crit.sort_values('Date').reset_index(drop=True)\n",
    ),
]

TRACEABILITY = [
    # Mismo docstring que en pr_runner.
    (
        "    \"\"\"Minutos a SUMAR a cada fecha del SCADA para llevarla a la escala de PVsyst.\n",
        "    \"\"\"Minutos de desfase de T08, con el signo de T08 (los que se le suman a PVsyst).\n"
        "\n"
        "    Aqui se RESTAN a las fechas del SCADA para agrupar igual que pr_runner; la\n"
        "    columna A del Excel se queda en hora real y son las busquedas contra PVsyst\n"
        "    las que llevan el -shift.\n",
    ),
    # Bucket key: el SCADA baja a la escala de PVsyst.
    (
        "    # Mismo time-shift que pr_runner: se desplaza el SCADA (serie nativa) ANTES de\n"
        "    # agrupar, redondeado a su resolucion. proc_pvsyst va sin tocar, en su :00.\n"
        "    _ts_min = scada_time_shift(scada_proc_df['Date'], plant_code, _scada_res)\n"
        "    _bkeys  = (scada_proc_df['Date'] + pd.to_timedelta(_ts_min, unit='m')).dt.floor(_freq)\n",

        "    # Mismo time-shift que pr_runner: el desfase de T08 se le suma a PVsyst, que es\n"
        "    # lo mismo que RESTARSELO al SCADA (serie nativa) antes de agrupar, redondeado\n"
        "    # a su resolucion. proc_pvsyst va sin tocar, en su :00.\n"
        "    _ts_min = scada_time_shift(scada_proc_df['Date'], plant_code, _scada_res)\n"
        "    _bkeys  = (scada_proc_df['Date'] - pd.to_timedelta(_ts_min, unit='m')).dt.floor(_freq)\n",
    ),
    # Columna A en hora real + clave de busqueda desplazada.
    (
        "        # Date = fecha de 03 + el time-shift T08 del tramo (en dias para Excel).\n"
        "        # Con esto $A esta en la escala de PVsyst y las busquedas por hora de\n"
        "        # abajo (INT($A*24), HOUR($A)) cuadran con lo que hace pr_runner.\n"
        "        _sh_txt = '' if _sh == 0 else (f'+{_sh}/1440' if _sh > 0 else f'-{abs(_sh)}/1440')\n"
        "        ws_cmp.cell(row=r_cmp, column=1,\n"
        "                    value=f\"='{_psheet}'!{_date_l}{_r0}{_sh_txt}\").number_format = 'yyyy-mm-dd hh:mm'\n",

        "        # Date = fecha de 03 TAL CUAL: la columna A va en hora real, igual que las\n"
        "        # fechas que escribe pr_runner. El time-shift T08 del tramo (en dias para\n"
        "        # Excel) se le RESTA solo dentro de las busquedas contra PVsyst, que es\n"
        "        # donde hace falta bajar a su escala.\n"
        "        _sh_pv = _A if _sh == 0 else f'({_A}-{_sh}/1440)'\n"
        "        ws_cmp.cell(row=r_cmp, column=1,\n"
        "                    value=f\"='{_psheet}'!{_date_l}{_r0}\").number_format = 'yyyy-mm-dd hh:mm'\n",
    ),
    # Busqueda de E_Grid.
    (
        "        # Expected energy = PVsyst E_Grid for the hour (matched on the shifted $A) * dt_h  (dynamic)\n"
        "        if pv_egrid:\n"
        "            ws_cmp.cell(row=r_cmp, column=4,\n"
        "                        value=f\"=SUMPRODUCT((INT(tbl_pv[Date]*24)=INT({_A}*24))*tbl_pv[{pv_egrid}])*{_dt_h_cmp}\").number_format = '0.000'\n",

        "        # Expected energy = PVsyst E_Grid for the hour (matched on $A - shift) * dt_h  (dynamic)\n"
        "        if pv_egrid:\n"
        "            ws_cmp.cell(row=r_cmp, column=4,\n"
        "                        value=f\"=SUMPRODUCT((INT(tbl_pv[Date]*24)=INT({_sh_pv}*24))*tbl_pv[{pv_egrid}])*{_dt_h_cmp}\").number_format = '0.000'\n",
    ),
    # Busqueda de POA.
    (
        "        # Expected POA = PVsyst POA for the hour (matched on the shifted $A)  (dynamic)\n"
        "        if 'POA' in pv_col_letter:\n"
        "            ws_cmp.cell(row=r_cmp, column=8,\n"
        "                        value=f\"=IFERROR(SUMPRODUCT((INT(tbl_pv[Date]*24)=INT({_A}*24))*tbl_pv[POA]),\\\"\\\")\").number_format = '0.00'\n",

        "        # Expected POA = PVsyst POA for the hour (matched on $A - shift)  (dynamic)\n"
        "        if 'POA' in pv_col_letter:\n"
        "            ws_cmp.cell(row=r_cmp, column=8,\n"
        "                        value=f\"=IFERROR(SUMPRODUCT((INT(tbl_pv[Date]*24)=INT({_sh_pv}*24))*tbl_pv[POA]),\\\"\\\")\").number_format = '0.00'\n",
    ),
    # Comentario del perfil horario (ahora en hora real).
    (
        "        # Hour of day (from the shifted $A) for the hourly profile\n",
        "        # Hour of day (hora real, $A) for the hourly profile\n",
    ),
]


def patch(nb_name, pairs):
    path = FAB / nb_name / 'notebook-content.ipynb'
    nb = json.loads(path.read_text(encoding='utf-8'))
    applied = skipped = 0

    for old, new in pairs:
        hits = 0
        for cell in nb['cells']:
            src = cell['source']
            text = src if isinstance(src, str) else ''.join(src)
            if new in text:
                skipped += 1
                hits = -1
                break
            if old in text:
                if text.count(old) != 1:
                    sys.exit(f'ERROR: {nb_name}: el patron aparece {text.count(old)} veces:\n{old[:80]}')
                cell['source'] = text.replace(old, new).splitlines(keepends=True)
                hits += 1
        if hits == 0:
            sys.exit(f'ERROR: {nb_name}: no se encontro el patron:\n{old[:120]}')
        if hits > 0:
            applied += hits

    # Fabric rechaza `source` como string: tiene que ser lista de lineas.
    for cell in nb['cells']:
        if isinstance(cell['source'], str):
            cell['source'] = cell['source'].splitlines(keepends=True)

    path.write_text(json.dumps(nb, indent=1, ensure_ascii=False), encoding='utf-8')
    print(f'{nb_name}: {applied} cambios aplicados, {skipped} ya estaban')


if __name__ == '__main__':
    patch('pr_runner.Notebook', PR_RUNNER)
    patch('traceability_export.Notebook', TRACEABILITY)
