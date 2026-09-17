"""La marca de tiempo del resultado vuelve a la HORA EN PUNTO.

Parte del estado del commit 181978a (ver scripts/fix_timeshift_sign.py).

Al devolver las fechas a hora real se sumaba el desfase EXACTO de T08. Para PL1
(72 -> 75 min, la rejilla del SCADA es de 15) eso dejaba el `ts` de pr_results a
y cuarto: 3.152 filas a :15 y el MERGE por (plant_code, ts) sin pisar las viejas
a :00. Los datos no estaban mal -el bucket cubre de verdad de 00:15 a 01:15
reales-, pero la serie tiene que salir en horas en punto como las demas plantas.

Ahora el resto sub-horario del desfase hace solo lo que le toca -decidir QUE
cuartos caen en cada bucket, que para eso se agrupa sobre la rejilla desplazada-
y la etiqueta se devuelve con el desfase REDONDEADO A LA HORA. traceability_export
hace lo mismo: la columna A del Excel se redondea hacia abajo a la hora, para que
siga cuadrando con el ts de pr_results, y la busqueda contra PVsyst usa el mismo
desfase redondeado.

Idempotente: si un notebook ya esta parcheado, se salta.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FAB = ROOT / '_fab_export'

PR_RUNNER = [
    (
        "    # El SCADA venia desplazado -shift para casar el bucket con PVsyst; aqui se\n"
        "    # deshace y todo pasa a HORA REAL. Neto: el desfase queda aplicado a la\n"
        "    # esperada y a la garantizada (que es como se valido), y las fechas que salen\n"
        "    # -dias, perfil horario, ts de cada intervalo- son las del SCADA.\n"
        "    if '_shift_min' in df.columns:\n"
        "        df['Date'] = df['Date'] + pd.to_timedelta(df['_shift_min'].fillna(0), unit='m')\n",

        "    # El SCADA venia desplazado -shift para casar el bucket con PVsyst; aqui se\n"
        "    # deshace y todo pasa a HORA REAL. Neto: el desfase queda aplicado a la\n"
        "    # esperada y a la garantizada (que es como se valido), y las fechas que salen\n"
        "    # -dias, perfil horario, ts de cada intervalo- son las del SCADA.\n"
        "    #\n"
        "    # Se suma el desfase REDONDEADO A LA HORA, no el exacto: la parte sub-horaria\n"
        "    # (los 15 min sueltos de los 75 de PL1) ya ha hecho su trabajo al agrupar, que\n"
        "    # era decidir QUE cuartos caen en cada bucket. La etiqueta tiene que quedar en\n"
        "    # la hora en punto, como en el resto de plantas, o el ts de PL1 sale a y cuarto\n"
        "    # y el MERGE de pr_results no pisa las filas de corridas anteriores.\n"
        "    if '_shift_min' in df.columns:\n"
        "        _back = (df['_shift_min'].fillna(0) / 60).round().astype('int64') * 60\n"
        "        df['Date'] = df['Date'] + pd.to_timedelta(_back, unit='m')\n",
    ),
]

TRACEABILITY = [
    (
        "        _sh_pv = _A if _sh == 0 else f'({_A}-{_sh}/1440)'\n"
        "        ws_cmp.cell(row=r_cmp, column=1,\n"
        "                    value=f\"='{_psheet}'!{_date_l}{_r0}\").number_format = 'yyyy-mm-dd hh:mm'\n",

        "        # La fecha de 03 se redondea HACIA ABAJO a la hora: el primer cuarto del\n"
        "        # bucket cae a y cuarto en PL1 (sus 75 min) y pr_runner escribe la hora en\n"
        "        # punto, asi que sin el redondeo la columna A no cuadraria con pr_results.\n"
        "        # La busqueda contra PVsyst baja a su escala con el MISMO desfase redondeado.\n"
        "        _sh_h  = int(round(_sh / 60.0)) * 60\n"
        "        _sh_pv = _A if _sh_h == 0 else f'({_A}-{_sh_h}/1440)'\n"
        "        ws_cmp.cell(row=r_cmp, column=1,\n"
        "                    value=f\"=FLOOR('{_psheet}'!{_date_l}{_r0},1/24)\").number_format = 'yyyy-mm-dd hh:mm'\n",
    ),
]


def patch(nb_name, pairs):
    path = FAB / nb_name / 'notebook-content.ipynb'
    nb = json.loads(path.read_text(encoding='utf-8'))
    applied = skipped = 0

    for old, new in pairs:
        done = False
        for cell in nb['cells']:
            src = cell['source']
            text = src if isinstance(src, str) else ''.join(src)
            if new in text:
                skipped += 1
                done = True
                break
            if old in text:
                if text.count(old) != 1:
                    sys.exit(f'ERROR: {nb_name}: el patron aparece {text.count(old)} veces')
                cell['source'] = text.replace(old, new).splitlines(keepends=True)
                applied += 1
                done = True
                break
        if not done:
            sys.exit(f'ERROR: {nb_name}: no se encontro el patron:\n{old[:120]}')

    # Fabric rechaza `source` como string: tiene que ser lista de lineas.
    for cell in nb['cells']:
        if isinstance(cell['source'], str):
            cell['source'] = cell['source'].splitlines(keepends=True)

    path.write_text(json.dumps(nb, indent=1, ensure_ascii=False), encoding='utf-8')
    print(f'{nb_name}: {applied} cambios aplicados, {skipped} ya estaban')


if __name__ == '__main__':
    patch('pr_runner.Notebook', PR_RUNNER)
    patch('traceability_export.Notebook', TRACEABILITY)
