"""Corrige el comentario del bloque de time-shift: al redondear a la rejilla del
SCADA los buckets horarios NO salen desparejos (comprobado con el T08 real)."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

OLD = (
    "# OJO: un desfase que no sea multiplo de 60 (p.ej. 75) deja buckets horarios\n"
    "# desparejos, de 3 o 4 intervalos de 15 min. No falsea el PR porque la\n"
    "# agregacion es por MEDIA (potencia), no por suma.\n"
)
NEW = (
    "# Al ser multiplo de la rejilla, el SCADA desplazado SIGUE siendo una rejilla de\n"
    "# 15 min y cada bucket horario conserva sus 4 intervalos: solo quedan buckets\n"
    "# parciales en los bordes del periodo y en la costura del cambio de hora.\n"
    "# Lo que si deja un desfase que no es multiplo de 60 (p.ej. los 75 de PL1) es que\n"
    "# uno de los 4 cuartos de cada hora de PVsyst cae en el bucket de al lado: se\n"
    "# alinea mejor la hora solar a cambio de mezclar un cuarto con la hora vecina.\n"
)

for nb_name in ('pr_runner', 'traceability_export'):
    path = ROOT / '_fab_export' / f'{nb_name}.Notebook' / 'notebook-content.ipynb'
    nb = json.loads(path.read_text(encoding='utf-8'))
    hits = 0
    for c in nb['cells']:
        if c['cell_type'] != 'code':
            continue
        s = ''.join(c['source'])
        if OLD not in s:
            continue
        s = s.replace(OLD, NEW)
        lines = s.split('\n')
        c['source'] = [ln + '\n' for ln in lines[:-1]] + ([lines[-1]] if lines[-1] else [])
        hits += 1
    if not hits:
        print(f'{nb_name}: comentario no encontrado (ya corregido?)')
        continue
    path.write_text(json.dumps(nb, indent=2, ensure_ascii=False) + '\n',
                    encoding='utf-8', newline='\n')
    print(f'{nb_name}: comentario corregido')
